-- Migration: unlink (pairing dissolution) transactional RPC
-- Feature: ldr-companion-app (task 13.2)
--
-- Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
--
-- The unlink Edge Function decides the outcome with the shared PURE logic
-- (@ldr/core `dissolvePairing`), but the AUTHORITATIVE mutation must be ATOMIC:
-- dissolving the pairing, unpairing both accounts, terminating any active
-- game/quiz session, and inserting the pairing-ended / session-ended
-- notifications all have to commit together, or a partner could end up unpaired
-- with a session still running, or dissolved with no notification. This function
-- is that single transaction. It is invoked as a PostgREST RPC with the
-- service_role from the Edge Function (design.md: sensitive transitions run in
-- Edge Functions with service-role privileges).
--
-- Like `public.accept_invitation` (migration 20260826062550) it lives in
-- `public` so `.rpc()` can route to it, but EXECUTE is revoked from PUBLIC and
-- granted ONLY to service_role, so `authenticated`/`anon` cannot dissolve a
-- pairing directly.
--
-- Requirement mapping inside the transaction:
--   * 4.1 — the pairing row moves to 'dissolved' (single round trip, well under
--           the 5s budget).
--   * 4.3 — both member accounts get `pairing_id` cleared, so each is free to
--           create or accept a new invitation.
--   * 4.4 — clearing `pairing_id` is exactly what the pairing-scope RLS
--           predicate (`pairing_id = app.current_pairing(auth.uid())`) reads, so
--           every pairing-owned row becomes unreachable to both former partners
--           while their individual rows (account, notifications, settings) are
--           untouched.
--   * 4.6 — every non-terminal rt_session / async_session and every
--           not-yet-complete quiz_session owned by the pairing is terminated,
--           and a session-ended notification is written for both partners.
--   * 4.2 / 4.5 — notifications are inserted with `delivered_at` left NULL, so
--           delivery is deferred until each partner next has a session.
--
-- `p_notifications` carries the notification rows produced by the pure helper
-- (its deterministic `dedupeKey`s are the dedupe identity). The function also
-- synthesizes session-ended rows for every session it actually terminated, using
-- the same `session-ended:{sessionId}:{recipient}` key format, so a session that
-- started between the Edge Function's read and this transaction still yields a
-- notification. Both inserts are ON CONFLICT DO NOTHING against the
-- (recipient_account_id, dedupe_key) unique index, so overlap collapses to one
-- row and a retried unlink is idempotent.
--
-- Returns a (result_code, dissolved_pairing_id, terminated_session_ids) row.
-- `result_code` is 'OK' or the stable @ldr/core code 'NOT_PAIRED'; the Edge
-- Function maps it to the HTTP response. The OUT names deliberately avoid the
-- column names used below (`pairing_id`, `id`) so no plpgsql column/variable
-- ambiguity can arise.

create or replace function public.dissolve_pairing (
  p_pairing       uuid,
  p_actor         uuid,
  p_now           timestamptz default now(),
  p_notifications jsonb default '[]'::jsonb
)
  returns table (
    result_code             text,
    dissolved_pairing_id    uuid,
    terminated_session_ids  uuid[]
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing     pairings%rowtype;
  v_sessions    jsonb := '[]'::jsonb;  -- [{ id, kind }] actually terminated
  v_batch       jsonb;
  v_terminated  uuid[];
begin
  -- Lock the pairing for the whole transaction so two concurrent unlink calls
  -- (one from each partner) serialize: the second sees status 'dissolved'.
  select * into v_pairing
  from pairings
  where id = p_pairing
  for update;

  if not found then
    return query select 'NOT_PAIRED'::text, null::uuid, null::uuid[];
    return;
  end if;

  -- Only a member may dissolve the pairing, and only an active pairing can be
  -- dissolved (mirrors the pure helper's NOT_PAIRED rejection).
  if p_actor <> v_pairing.member_a and p_actor <> v_pairing.member_b then
    return query select 'NOT_PAIRED'::text, null::uuid, null::uuid[];
    return;
  end if;

  if v_pairing.status <> 'active' then
    return query select 'NOT_PAIRED'::text, null::uuid, null::uuid[];
    return;
  end if;

  -- Lock both member rows so their pairing state cannot change underneath us.
  perform 1 from accounts
  where id in (v_pairing.member_a, v_pairing.member_b)
  for update;

  -- ---- Terminate active sessions owned by the pairing (Req 4.6) ----------
  -- Real-time sessions: anything not already terminal.
  with terminated as (
    update rt_sessions
    set state = 'terminal',
        outcome = coalesce(outcome, jsonb_build_object('reason', 'pairing_dissolved')),
        updated_at = p_now
    where pairing_id = v_pairing.id
      and state <> 'terminal'
    returning id
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('id', terminated.id, 'kind', 'realtime')),
           '[]'::jsonb
         )
  into v_batch
  from terminated;
  v_sessions := v_sessions || v_batch;

  -- Asynchronous sessions: anything not already terminal.
  with terminated as (
    update async_sessions
    set state = 'terminal',
        outcome = coalesce(outcome, jsonb_build_object('reason', 'pairing_dissolved')),
        updated_at = p_now
    where pairing_id = v_pairing.id
      and state <> 'terminal'
    returning id
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('id', terminated.id, 'kind', 'async')),
           '[]'::jsonb
         )
  into v_batch
  from terminated;
  v_sessions := v_sessions || v_batch;

  -- Quiz sessions: a run is active until its phase reaches 'complete'
  -- (Req 8.11 uses the same predicate for the one-active-session index).
  with terminated as (
    update quiz_sessions
    set phase = 'complete',
        updated_at = p_now
    where pairing_id = v_pairing.id
      and phase <> 'complete'
    returning id
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('id', terminated.id, 'kind', 'quiz')),
           '[]'::jsonb
         )
  into v_batch
  from terminated;
  v_sessions := v_sessions || v_batch;

  -- ---- Dissolve the pairing (Req 4.1) -----------------------------------
  update pairings
  set status = 'dissolved',
      dissolved_at = p_now
  where id = v_pairing.id;

  -- ---- Unpair both accounts (Req 4.3) -----------------------------------
  -- This is also what revokes access to all pairing-owned data (Req 4.4),
  -- because the pairing-scope RLS predicate reads accounts.pairing_id. Every
  -- other column of each account is left intact (individual data is retained).
  update accounts
  set pairing_id = null
  where id in (v_pairing.member_a, v_pairing.member_b);

  -- ---- Notifications from the pure helper (Req 4.2, 4.5) ----------------
  -- Only rows addressed to the two former partners are accepted, so a malformed
  -- payload can never write a notification into an unrelated account.
  insert into notifications (
    recipient_account_id, category, payload, dedupe_key, created_at
  )
  select (n ->> 'recipient_account_id')::uuid,
         (n ->> 'category')::notification_category,
         coalesce(n -> 'payload', '{}'::jsonb),
         n ->> 'dedupe_key',
         coalesce((n ->> 'created_at')::timestamptz, p_now)
  from jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) as n
  where n ->> 'recipient_account_id' is not null
    and n ->> 'dedupe_key' is not null
    and n ->> 'category' is not null
    and (n ->> 'recipient_account_id')::uuid
        in (v_pairing.member_a, v_pairing.member_b)
  on conflict (recipient_account_id, dedupe_key) do nothing;

  -- ---- Session-ended notifications for what we actually terminated ------
  -- Safety net for a session created after the Edge Function's read: same
  -- deterministic dedupe key as the pure helper, so overlapping rows collapse.
  insert into notifications (
    recipient_account_id, category, payload, dedupe_key, created_at
  )
  select r.recipient,
         'system'::notification_category,
         jsonb_build_object(
           'type', 'session_ended',
           'pairingId', v_pairing.id,
           'sessionId', s ->> 'id',
           'sessionKind', s ->> 'kind'
         ),
         'session-ended:' || (s ->> 'id') || ':' || r.recipient,
         p_now
  from jsonb_array_elements(v_sessions) as s
  cross join (values (v_pairing.member_a), (v_pairing.member_b)) as r (recipient)
  on conflict (recipient_account_id, dedupe_key) do nothing;

  select coalesce(array_agg((s ->> 'id')::uuid), '{}'::uuid[])
  into v_terminated
  from jsonb_array_elements(v_sessions) as s;

  return query select 'OK'::text, v_pairing.id, v_terminated;
end;
$$;

comment on function public.dissolve_pairing (uuid, uuid, timestamptz, jsonb) is
  'Atomic unlink transaction: dissolves an active pairing, unpairs both accounts (revoking pairing-scoped RLS access), terminates every active rt/async/quiz session, and inserts deduped pairing-ended/session-ended notifications with deferred delivery (Req 4.1-4.6).';

-- Lock down execution: revoke the default PUBLIC grant and allow ONLY the
-- service_role (used by the unlink Edge Function), so dissolution stays
-- server-authoritative.
revoke execute on function public.dissolve_pairing (uuid, uuid, timestamptz, jsonb)
  from public;
grant execute on function public.dissolve_pairing (uuid, uuid, timestamptz, jsonb)
  to service_role;
