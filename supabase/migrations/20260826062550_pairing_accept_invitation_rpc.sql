-- Migration: acceptInvitation transactional RPC
-- Feature: ldr-companion-app (task 13.1)
--
-- Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.8
--
-- The acceptInvitation Edge Function performs its friendly pre-validation with
-- the shared pure logic (@ldr/core acceptInvitation), but the AUTHORITATIVE and
-- ATOMIC mutation must run inside a single Postgres transaction so that two
-- partners accepting concurrently cannot both succeed. This function is that
-- transaction. It is invoked as a PostgREST RPC with the service_role from the
-- Edge Function (design.md: sensitive transitions run in Edge Functions with
-- service-role privileges).
--
-- It lives in `public` (the only schema exposed by the Data API, so `.rpc()`
-- can route to it) but EXECUTE is revoked from PUBLIC and granted ONLY to
-- service_role. `authenticated`/`anon` therefore cannot invoke it — the guard is
-- the privilege grant, not schema hiding. (The RLS helper functions in the `app`
-- schema stay there because they are only referenced inside policies, never
-- called over the API.)
--
-- Concurrency guard: the pairing insert relies on the partial UNIQUE indexes
-- `pairings_member_a_active_uidx` / `pairings_member_b_active_uidx` created in
-- task 2.1. If a concurrent accept has already paired either account, the insert
-- raises unique_violation, which is translated to the ALREADY_PAIRED result
-- code (Req 3.6). The invitation row is locked FOR UPDATE for the duration of
-- the transaction so it can be consumed exactly once (single-use, Req 3.8).
--
-- Returns a (result_code, pairing_id) row. `result_code` is one of the stable
-- @ldr/core error codes, or 'OK' on success; the Edge Function maps it to the
-- HTTP response.

create or replace function public.accept_invitation (
  p_code    text,
  p_invitee uuid,
  p_now     timestamptz default now()
)
  returns table (result_code text, pairing_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_inv            invitations%rowtype;
  v_inviter_paired boolean;
  v_invitee_paired boolean;
  v_pairing_id     uuid;
begin
  -- Lock the invitation for the whole transaction (single-use guard, Req 3.8).
  select * into v_inv
  from invitations
  where code = p_code
  for update;

  if not found then
    return query select 'INVITATION_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  -- Already used to create a pairing (Req 3.8).
  if v_inv.status = 'consumed' then
    return query select 'INVITATION_ALREADY_CONSUMED'::text, null::uuid;
    return;
  end if;

  -- Accepted after the 72h window, or already marked expired (Req 3.5).
  if v_inv.status = 'expired' or p_now > v_inv.expires_at then
    return query select 'INVITATION_EXPIRED'::text, null::uuid;
    return;
  end if;

  -- An account cannot pair with itself.
  if v_inv.inviter_account_id = p_invitee then
    return query select 'ALREADY_PAIRED'::text, null::uuid;
    return;
  end if;

  -- Exclusivity pre-check: reject if either the inviter or the invitee is
  -- already in a pairing (Req 3.3, 3.4, 3.6). Lock both account rows so their
  -- pairing state cannot change underneath this transaction.
  select (pairing_id is not null) into v_inviter_paired
  from accounts
  where id = v_inv.inviter_account_id
  for update;

  select (pairing_id is not null) into v_invitee_paired
  from accounts
  where id = p_invitee
  for update;

  if coalesce(v_inviter_paired, false) or coalesce(v_invitee_paired, false) then
    return query select 'ALREADY_PAIRED'::text, null::uuid;
    return;
  end if;

  -- Create the pairing (Req 3.2). The partial UNIQUE indexes on active
  -- membership are the ultimate guard against a concurrent double-accept: a
  -- racing transaction that paired either account first makes this insert raise
  -- unique_violation, which we translate to ALREADY_PAIRED (Req 3.6).
  begin
    insert into pairings (member_a, member_b, status, created_at)
    values (v_inv.inviter_account_id, p_invitee, 'active', p_now)
    returning id into v_pairing_id;
  exception when unique_violation then
    return query select 'ALREADY_PAIRED'::text, null::uuid;
    return;
  end;

  -- Link both accounts to the new pairing.
  update accounts set pairing_id = v_pairing_id
  where id in (v_inv.inviter_account_id, p_invitee);

  -- Consume the invitation so it can never be reused (Req 3.8).
  update invitations
  set status = 'consumed', consumed_at = p_now
  where id = v_inv.id;

  return query select 'OK'::text, v_pairing_id;
end;
$$;

comment on function public.accept_invitation (text, uuid, timestamptz) is
  'Atomic acceptInvitation transaction: validates expiry/consumption/exclusivity, creates the pairing (guarded by the partial UNIQUE active-membership indexes), links both accounts, and consumes the single-use invitation (Req 3.2-3.8).';

-- Lock down execution: revoke the default PUBLIC grant and allow ONLY the
-- service_role (used by the Edge Function). `authenticated`/`anon` cannot invoke
-- it over the Data API, so acceptance stays server-authoritative.
revoke execute on function public.accept_invitation (text, uuid, timestamptz)
  from public;
grant execute on function public.accept_invitation (text, uuid, timestamptz)
  to service_role;
