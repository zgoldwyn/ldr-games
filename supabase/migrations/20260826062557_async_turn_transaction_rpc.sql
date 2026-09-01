-- Migration: asynchronous game session start + takeTurn transactional RPCs
-- Feature: ldr-companion-app (task 16.1)
--
-- Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10
--
-- The async-take-turn / async-start Edge Functions decide *what* a turn means
-- with the shared pure engine (`@ldr/core` applyTurn + the per-game rulesets),
-- but the AUTHORITATIVE mutation has to be atomic: the new game state, the
-- transferred Active_Turn_Holder designation, the fresh turn-pending stamp, the
-- recorded terminal outcome, and the notification rows must all land together or
-- not at all (Req 7.5, 7.6, 7.10). These functions are those transactions.
--
-- Both live in `public` (the only schema exposed by the Data API, so `.rpc()`
-- can route to them) but EXECUTE is revoked from PUBLIC and granted ONLY to
-- service_role, so turn application stays server-authoritative: clients hold
-- SELECT-only rights on `async_sessions` (migration 20260826062549).
--
-- Concurrency guard: `async_take_turn` locks the session row `FOR UPDATE` and
-- re-checks the holder and the turn count that the Edge Function based its pure
-- decision on. A racing second turn therefore cannot be applied on top of a
-- stale read — the loser is rejected with NOT_YOUR_TURN and the state is left
-- unchanged (Req 7.4, 7.7).
--
-- Postgres Changes: `async_sessions` and `notifications` are added to the
-- `supabase_realtime` publication at the end of this migration so the committed
-- state transfer and the your-turn notification reach the partner's client
-- through a Postgres Changes subscription (design "Async Game Module"). Both
-- tables are RLS-protected, so a subscriber only receives rows it may read.

-- ---------------------------------------------------------------------------
-- Shared helper: insert derived notification rows
-- ---------------------------------------------------------------------------
-- `p_notifications` is a JSON array of
--   { recipient, category, payload, dedupe_key }
-- objects derived by the pure core (`deriveTurnHandoffNotification`, and the
-- terminal-outcome notifications for Req 7.10). Insertion is idempotent on
-- (recipient_account_id, dedupe_key) so re-deriving the same turn's
-- notification never produces a duplicate (Req 11.6). Rows are inserted with
-- `delivered_at` NULL: a partner without a current Authenticated_Session picks
-- them up on next sign-in (Req 7.6, 7.10).
create or replace function app.insert_derived_notifications (
  p_notifications jsonb,
  p_now           timestamptz
)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_inserted integer := 0;
begin
  if p_notifications is null or jsonb_typeof(p_notifications) <> 'array' then
    return 0;
  end if;

  insert into notifications (
    recipient_account_id, category, payload, dedupe_key, created_at
  )
  select
    (n ->> 'recipient')::uuid,
    (n ->> 'category')::notification_category,
    coalesce(n -> 'payload', '{}'::jsonb),
    n ->> 'dedupe_key',
    p_now
  from jsonb_array_elements(p_notifications) as n
  where n ->> 'recipient' is not null
    and n ->> 'dedupe_key' is not null
  on conflict (recipient_account_id, dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

comment on function app.insert_derived_notifications (jsonb, timestamptz) is
  'Idempotently inserts core-derived notification rows (dedupe on recipient + dedupe_key, Req 11.6).';

revoke execute on function app.insert_derived_notifications (jsonb, timestamptz)
  from public;

-- ---------------------------------------------------------------------------
-- public.async_start_session — create the session + designate the first holder
-- ---------------------------------------------------------------------------
-- Requirement 7.2: creating an Asynchronous_Game_Session designates one partner
-- as the Active_Turn_Holder per the game's rules (computed purely by the Edge
-- Function) and delivers an invitation notification to the other partner. Both
-- happen in this one transaction. Requirement 7.9 is pre-checked by the Edge
-- Function via `requirePairing` and re-checked here against the pairing row.
-- `p_session` is supplied by the caller so the invitation notification's payload
-- and dedupe key can reference the session id inside this same transaction.
create or replace function public.async_start_session (
  p_session       uuid,
  p_pairing       uuid,
  p_actor         uuid,
  p_game_id       text,
  p_holder        uuid,
  p_game_state    jsonb,
  p_now           timestamptz default now(),
  p_notifications jsonb default '[]'::jsonb
)
  returns table (result_code text, session_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pairing pairings%rowtype;
  v_session uuid;
begin
  select * into v_pairing from pairings where id = p_pairing for share;

  -- No active pairing -> a partner is required (Req 7.9).
  if not found or v_pairing.status <> 'active' then
    return query select 'PAIRING_REQUIRED'::text, null::uuid;
    return;
  end if;

  if p_actor not in (v_pairing.member_a, v_pairing.member_b)
     or p_holder not in (v_pairing.member_a, v_pairing.member_b) then
    return query select 'PAIRING_REQUIRED'::text, null::uuid;
    return;
  end if;

  insert into async_sessions (
    id, pairing_id, game_id, state, active_turn_holder,
    turn_pending_since, game_state, created_at, updated_at
  )
  values (
    coalesce(p_session, gen_random_uuid()), p_pairing, p_game_id, 'active',
    p_holder, p_now, p_game_state, p_now, p_now
  )
  returning id into v_session;

  -- Invitation notification for the other partner (Req 7.2).
  perform app.insert_derived_notifications(p_notifications, p_now);

  return query select 'OK'::text, v_session;
end;
$$;

comment on function public.async_start_session (uuid, uuid, uuid, text, uuid, jsonb, timestamptz, jsonb) is
  'Atomically creates an async game session with its initial Active_Turn_Holder and the partner''s invitation notification (Req 7.2, 7.9).';

revoke execute on function public.async_start_session (uuid, uuid, uuid, text, uuid, jsonb, timestamptz, jsonb)
  from public;
grant execute on function public.async_start_session (uuid, uuid, uuid, text, uuid, jsonb, timestamptz, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- public.async_take_turn — commit the turn and transfer ownership atomically
-- ---------------------------------------------------------------------------
-- The Edge Function has already run the pure `applyTurn` against the state it
-- read, so this transaction's job is (a) to prove that read is still current and
-- (b) to commit every consequence of the turn together:
--   * the new authoritative `game_state` (which embeds the recorded turn, Req 7.5),
--   * the transferred `active_turn_holder` (Req 7.5),
--   * a fresh `turn_pending_since` (restarts the 48h nudge window, Req 7.12),
--   * the terminal `state`/`outcome` when the game ended (Req 7.10), and
--   * the derived notifications (your-turn, Req 7.6; result, Req 7.10).
--
-- `p_expected_holder` / `p_expected_turn_count` are the compare-and-swap guard:
-- they must still match the locked row, otherwise a concurrent turn already
-- advanced the session and this one is rejected with the state unchanged
-- (Req 7.4, 7.7).
create or replace function public.async_take_turn (
  p_session             uuid,
  p_actor               uuid,
  p_expected_holder     uuid,
  p_expected_turn_count integer,
  p_game_state          jsonb,
  p_next_holder         uuid,
  p_next_state          async_session_state,
  p_outcome             jsonb default null,
  p_now                 timestamptz default now(),
  p_notifications       jsonb default '[]'::jsonb
)
  returns table (
    result_code        text,
    session_id         uuid,
    pairing_id         uuid,
    game_id            text,
    state              async_session_state,
    active_turn_holder uuid,
    turn_pending_since timestamptz,
    game_state         jsonb,
    outcome            jsonb
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_session    async_sessions%rowtype;
  v_turn_count integer;
begin
  -- Serialize concurrent turns on this session for the whole transaction.
  select * into v_session from async_sessions where id = p_session for update;

  if not found then
    return query select 'SESSION_NOT_FOUND'::text, null::uuid, null::uuid,
      null::text, null::async_session_state, null::uuid, null::timestamptz,
      null::jsonb, null::jsonb;
    return;
  end if;

  -- A turn may only be taken on an active session (Req 7.8, mirrors applyTurn).
  if v_session.state <> 'active' then
    return query select 'INVALID_TURN'::text, null::uuid, null::uuid,
      null::text, null::async_session_state, null::uuid, null::timestamptz,
      null::jsonb, null::jsonb;
    return;
  end if;

  -- Only the current Active_Turn_Holder may take the next turn (Req 7.4, 7.7).
  if v_session.active_turn_holder <> p_actor
     or v_session.active_turn_holder <> p_expected_holder then
    return query select 'NOT_YOUR_TURN'::text, null::uuid, null::uuid,
      null::text, null::async_session_state, null::uuid, null::timestamptz,
      null::jsonb, null::jsonb;
    return;
  end if;

  -- Compare-and-swap on the turn history length: if it moved, the Edge
  -- Function's pure decision was computed from a stale state, so reject rather
  -- than clobber the newer state (Req 7.7, 7.8 leave state unchanged).
  v_turn_count := coalesce(
    jsonb_array_length(coalesce(v_session.game_state -> 'turns', '[]'::jsonb)),
    0
  );
  if p_expected_turn_count is not null and v_turn_count <> p_expected_turn_count then
    return query select 'NOT_YOUR_TURN'::text, null::uuid, null::uuid,
      null::text, null::async_session_state, null::uuid, null::timestamptz,
      null::jsonb, null::jsonb;
    return;
  end if;

  -- Commit the turn: new state, transferred holder, fresh pending stamp, and the
  -- outcome when the game reached a terminal state (Req 7.5, 7.10).
  -- `async_sessions.outcome` is qualified because this function's RETURNS TABLE
  -- declares an `outcome` output variable; the qualification keeps the reference
  -- unambiguously the column.
  update async_sessions
  set game_state         = p_game_state,
      active_turn_holder = p_next_holder,
      state              = p_next_state,
      outcome            = coalesce(p_outcome, async_sessions.outcome),
      turn_pending_since = p_now,
      updated_at         = p_now
  where async_sessions.id = p_session
  returning * into v_session;

  -- Your-turn / result notifications, in the same transaction (Req 7.6, 7.10).
  perform app.insert_derived_notifications(p_notifications, p_now);

  return query select 'OK'::text, v_session.id, v_session.pairing_id,
    v_session.game_id, v_session.state, v_session.active_turn_holder,
    v_session.turn_pending_since, v_session.game_state, v_session.outcome;
end;
$$;

comment on function public.async_take_turn (uuid, uuid, uuid, integer, jsonb, uuid, async_session_state, jsonb, timestamptz, jsonb) is
  'Atomic async takeTurn transaction: re-checks the Active_Turn_Holder and turn count under a row lock, then commits the new game state, the holder transfer, the terminal outcome, and the derived notifications together (Req 7.4-7.8, 7.10).';

revoke execute on function public.async_take_turn (uuid, uuid, uuid, integer, jsonb, uuid, async_session_state, jsonb, timestamptz, jsonb)
  from public;
grant execute on function public.async_take_turn (uuid, uuid, uuid, integer, jsonb, uuid, async_session_state, jsonb, timestamptz, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Realtime: publish async session + notification changes (Postgres Changes)
-- ---------------------------------------------------------------------------
-- The partner observes the committed turn (state + holder transfer) and the
-- your-turn notification through Postgres Changes rather than a Broadcast, so
-- the update reaches them whether or not they were online when it happened
-- (Req 7.3, 7.6, 7.10). Guarded so re-running is safe and so a table another
-- migration already published is not added twice.
do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['async_sessions', 'notifications'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table
      ) then
        execute format(
          'alter publication supabase_realtime add table public.%I', v_table
        );
      end if;
    end loop;
  end if;
end $$;
