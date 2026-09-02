-- Feature: ldr-companion-app (fixes a defect in task 13.1)
--
-- `public.accept_invitation` raised at runtime on EVERY call, so pairing had
-- never worked:
--
--   ERROR: column reference "pairing_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   QUERY: select (pairing_id is not null) from accounts
--            where id = v_inv.inviter_account_id for update
--
-- The function is declared `returns table (result_code text, pairing_id uuid)`.
-- In PL/pgSQL a `returns table` column is an OUT parameter, i.e. a variable in
-- scope throughout the body -- so inside a query that also selects `FROM
-- accounts` (which has its own `pairing_id` column), the bare name is ambiguous
-- and Postgres refuses to guess.
--
-- The Edge Function caught the resulting rpcErr and mapped it to a generic
-- 500 INTERNAL_ERROR, which is why the failure looked like a server glitch
-- rather than a broken statement. Nothing had ever exercised it: task 13.1
-- shipped without an integration test, and 13.3 (which would have caught it) is
-- the task being written now.
--
-- FIX: qualify the two reads as `accounts.pairing_id`. The `update accounts set
-- pairing_id = ...` further down needs no change -- the left-hand side of SET is
-- unambiguously a column.
--
-- The rest of the body is unchanged from migration 20260826062550, reproduced
-- here because `create or replace function` must restate the whole definition.
--
-- Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8

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
  --
  -- `accounts.pairing_id` is qualified because the bare name would resolve to
  -- this function's OUT parameter of the same name.
  select (accounts.pairing_id is not null) into v_inviter_paired
  from accounts
  where accounts.id = v_inv.inviter_account_id
  for update;

  select (accounts.pairing_id is not null) into v_invitee_paired
  from accounts
  where accounts.id = p_invitee
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
  where accounts.id in (v_inv.inviter_account_id, p_invitee);

  -- Consume the invitation so it can never be reused (Req 3.8).
  update invitations
  set status = 'consumed', consumed_at = p_now
  where invitations.id = v_inv.id;

  return query select 'OK'::text, v_pairing_id;
end;
$$;

comment on function public.accept_invitation (text, uuid, timestamptz) is
  'Atomic acceptInvitation transaction: validates expiry/consumption/exclusivity, creates the pairing (guarded by the partial UNIQUE active-membership indexes), links both accounts, and consumes the single-use invitation (Req 3.2-3.8).';

-- `create or replace` preserves the existing grants, but they are restated so
-- this migration is self-contained if replayed against a fresh database.
revoke execute on function public.accept_invitation (text, uuid, timestamptz)
  from public;
grant execute on function public.accept_invitation (text, uuid, timestamptz)
  to service_role;
