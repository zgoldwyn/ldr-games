-- Migration: transactional application-data removal for account deletion
-- Feature: ldr-companion-app (task 21A.3)
--
-- Requirements: 12.3, 12.4, 12.5, 12.6
--
-- Auth users and Storage objects live outside Postgres, but every application
-- row can and must be removed atomically. This service-role-only RPC first
-- reuses dissolve_pairing (so the surviving partner receives the exact normal
-- unlink treatment), then removes the dissolved pairing and the departing
-- account. Pairing and account foreign keys cascade to all owned rows.

create or replace function public.delete_account_data (
  p_account       uuid,
  p_epoch         integer,
  p_pairing       uuid default null,
  p_now           timestamptz default now(),
  p_notifications jsonb default '[]'::jsonb
)
  returns table (
    result_code             text,
    deleted_pairing_ids     uuid[],
    remaining_partner_id    uuid,
    terminated_session_ids  uuid[]
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_account       accounts%rowtype;
  v_dissolution   record;
  v_partner       uuid;
  v_terminated    uuid[] := '{}'::uuid[];
  v_pairings      uuid[] := '{}'::uuid[];
  v_epoch         integer;
begin
  -- Pairing-owned mutations lock pairing before accounts. Match that order so
  -- deletion cannot deadlock with an in-flight game/quiz submission which
  -- holds the pairing while checking its members.
  if p_pairing is not null then
    perform 1 from pairings where id = p_pairing for update;
  end if;

  -- Serialize deletion with pairing acceptance/dissolution and other account
  -- transitions. A missing row means this request cannot begin; retries after
  -- this transaction are handled by the Edge Function's Auth metadata marker.
  select * into v_account
  from accounts
  where id = p_account
  for update;

  if not found then
    return query
      select 'ACCOUNT_NOT_FOUND'::text, '{}'::uuid[], null::uuid, '{}'::uuid[];
    return;
  end if;

  if v_account.pairing_id is distinct from p_pairing then
    return query
      select 'INVALID_DELETION_STATE'::text, '{}'::uuid[], null::uuid, '{}'::uuid[];
    return;
  end if;

  -- Lock and compare the session registry inside this transaction. This closes
  -- the race where a new login could displace the caller after the Edge Function
  -- checked its token but before privileged deletion began.
  select epoch into v_epoch
  from account_session
  where account_id = p_account
  for update;

  if not found or v_epoch <> p_epoch then
    return query
      select 'SESSION_SUPERSEDED'::text, '{}'::uuid[], null::uuid, '{}'::uuid[];
    return;
  end if;

  -- An account may have historical dissolved pairings as well as its current
  -- active one. Their SQL rows will cascade from the account delete, and every
  -- Storage prefix must be retained for the Edge Function's external cleanup.
  select coalesce(array_agg(p.id order by p.created_at), '{}'::uuid[])
    into v_pairings
  from pairings p
  where p.member_a = p_account or p.member_b = p_account;

  if p_pairing is not null then
    -- Resolve the surviving member before the pairing row is removed.
    select case
      when p.member_a = p_account then p.member_b
      when p.member_b = p_account then p.member_a
      else null
    end
      into v_partner
    from pairings p
    where p.id = p_pairing;

    if v_partner is null then
      return query
        select 'INVALID_DELETION_STATE'::text, '{}'::uuid[], null::uuid, '{}'::uuid[];
      return;
    end if;

    select * into v_dissolution
    from public.dissolve_pairing(
      p_pairing,
      p_account,
      p_now,
      p_notifications
    );

    if v_dissolution.result_code <> 'OK' then
      return query
        select v_dissolution.result_code::text,
               '{}'::uuid[],
               null::uuid,
               '{}'::uuid[];
      return;
    end if;

    v_terminated := coalesce(
      v_dissolution.terminated_session_ids,
      '{}'::uuid[]
    );

    -- All pairing-owned tables reference pairings ON DELETE CASCADE. The
    -- surviving partner was already unpaired and notified by dissolve_pairing.
    delete from pairings where id = p_pairing;
  end if;

  -- Store the external-cleanup resume context atomically with application-data
  -- deletion. JSONB concatenation updates only these keys and cannot overwrite
  -- a concurrent login's unrelated Auth metadata.
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) ||
    jsonb_build_object(
      'account_deletion_started', true,
      'account_deletion_pairing_ids', to_jsonb(v_pairings)
    )
  where id = p_account;

  -- Advance the epoch before removing its registry row. Within this transaction
  -- the subsequent account delete cascades the row; after commit the epoch
  -- guard fails closed because no registry row exists (Req 12.5).
  update account_session
  set epoch = epoch + 1,
      last_activity_at = p_now,
      updated_at = p_now
  where account_id = p_account;

  -- Account-owned rows (including notifications, invitations, lockout state,
  -- settings and the session registry) cascade from accounts.
  delete from accounts where id = p_account;

  return query select 'OK'::text, v_pairings, v_partner, v_terminated;
end;
$$;

comment on function public.delete_account_data (uuid, integer, uuid, timestamptz, jsonb) is
  'Atomically dissolves an active pairing, removes all pairing-owned rows, advances/removes the session epoch, and deletes the application account (Req 12.3-12.6).';

revoke execute on function public.delete_account_data (uuid, integer, uuid, timestamptz, jsonb)
  from public;
grant execute on function public.delete_account_data (uuid, integer, uuid, timestamptz, jsonb)
  to service_role;
