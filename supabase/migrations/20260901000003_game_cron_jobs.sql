-- Feature: ldr-companion-app (task 20.1)
--
-- Time-based game transitions driven by pg_cron:
--   * 60s real-time invitation-join expiry            (Requirement 6.9)
--   * 5-minute paused-session termination             (Requirement 6.10)
--   * 48-hour asynchronous turn nudge                 (Requirement 7.12)
--
-- WHY PLAIN plpgsql RATHER THAN CRON-INVOKED EDGE FUNCTIONS
-- ---------------------------------------------------------
-- design.md describes these as "cron jobs invoking Edge Functions". This is a
-- deliberate, documented deviation (see tasks.md section 20). All three jobs are
-- the same shape — compare a timestamp, transition a row, insert notifications —
-- which is exactly what `public.dissolve_pairing` and
-- `app.insert_derived_notifications` already do. Keeping them in the database:
--
--   * is TRANSACTIONAL. The state transition and its notifications commit
--     together. Across a cron -> pg_net -> HTTP -> Edge Function hop they cannot,
--     so a failure mid-flight could terminate a session and never tell anyone.
--   * is DETERMINISTICALLY TESTABLE. Every function takes `p_now`, the same
--     convention the other RPCs here follow, so a test passes a synthetic instant
--     instead of waiting for a real window. Without that, Requirement 7.12's
--     48-HOUR nudge is not practically testable at all.
--   * needs no `pg_net` reaching the edge runtime from inside the database
--     container, and no service-role secret for the cron caller.
--
-- The Edge Function guidance still stands for any scheduled job with real logic.
-- These three have none: the interesting logic already ran when the session was
-- created or paused.
--
-- THRESHOLD DUPLICATION
-- ---------------------
-- The windows below also exist as TypeScript constants, and this is the one real
-- cost of implementing here:
--
--   JOIN_WINDOW_MS          = 60 * 1000              packages/core/src/domain/rt-session.ts
--   REJOIN_WINDOW_MS        = 5 * 60 * 1000          packages/core/src/domain/rt-session.ts
--   TURN_NUDGE_THRESHOLD_MS = 48 * 60 * 60 * 1000    packages/core/src/domain/async-lifecycle.ts
--
-- Task 20.3's integration tests IMPORT those constants and assert the boundaries
-- below agree with them, bracketing each window at `threshold - 1s` and
-- `threshold + 1s`, so a divergence fails a test instead of going unnoticed.
--
-- PLACEMENT AND EXPOSURE
-- ----------------------
-- These live in `public` (not `app`) for the same reason `accept_invitation`,
-- `dissolve_pairing` and `async_take_turn` do: EXECUTE is revoked from PUBLIC and
-- granted only to `service_role`, so no client role can invoke them over the Data
-- API, while the integration tests can drive them through the same service-role
-- path as every other RPC. `returns setof uuid` is used deliberately instead of
-- `returns table (...)`: a `returns table` column is an OUT parameter that shadows
-- any same-named table column, which is precisely the bug fixed in migration
-- 20260901000001.
--
-- Requirements: 6.9, 6.10, 7.12, 11.6

create extension if not exists pg_cron;

-- ===========================================================================
-- Requirement 6.9 — cancel a pending session the partner never joined
-- ===========================================================================
-- The inviter is `joined_accounts[1]`: `rt-move`'s invite action creates the row
-- with `joined_accounts: [actor]`, so the array's first element IS the inviting
-- partner. That makes the session row self-sufficient — no need to reach into the
-- invitation notification to work out who to tell.
--
-- Terminal state uses kind `ended_without_outcome` (matching the core `RTOutcome`
-- union) with a `reason` that distinguishes this from a rejoin timeout.

create or replace function public.expire_pending_rt_sessions (
  p_now timestamptz default now()
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_notifications jsonb := '[]'::jsonb;
  v_row           record;
begin
  for v_row in
    with expired as (
      update rt_sessions s
         set state         = 'terminal',
             outcome       = jsonb_build_object(
                                'kind', 'ended_without_outcome',
                                'reason', 'invitation_expired',
                                'winner', null,
                                'recordedAt', (extract(epoch from p_now) * 1000)::bigint
                              ),
             -- The join deadline no longer applies once the session is terminal.
             pending_since = null,
             updated_at    = p_now
       where s.state = 'pending'
         and s.pending_since is not null
         -- JOIN_WINDOW_MS = 60s
         and s.pending_since <= p_now - interval '60 seconds'
      returning s.id, s.game_id, s.joined_accounts
    )
    select * from expired
  loop
    -- Req 6.9 names the INVITING partner as the recipient, not both partners.
    if v_row.joined_accounts is not null and array_length(v_row.joined_accounts, 1) >= 1 then
      v_notifications := v_notifications || jsonb_build_array(
        jsonb_build_object(
          'recipient', v_row.joined_accounts[1],
          'category',  'game_invite',
          'payload',   jsonb_build_object(
                         'kind', 'rt_invite_expired',
                         'sessionId', v_row.id,
                         'gameId', v_row.game_id
                       ),
          -- One notification per expired invitation (Req 11.6).
          'dedupe_key', 'rt:invite_expired:' || v_row.id::text
        )
      );
    end if;

    return next v_row.id;
  end loop;

  if jsonb_array_length(v_notifications) > 0 then
    perform app.insert_derived_notifications(v_notifications, p_now);
  end if;
end;
$$;

comment on function public.expire_pending_rt_sessions (timestamptz) is
  'Cancels pending real-time sessions past the 60s join window and notifies the inviting partner (Req 6.9). Returns the ids it cancelled.';

-- ===========================================================================
-- Requirement 6.10 — terminate a pause nobody rejoined
-- ===========================================================================
-- Both partners are notified here (unlike 6.9), because Req 6.10 says so: the
-- session ended for both of them, not just for whoever dropped out.

create or replace function public.terminate_abandoned_rt_pauses (
  p_now timestamptz default now()
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_notifications jsonb := '[]'::jsonb;
  v_row           record;
  v_pairing       pairings%rowtype;
begin
  for v_row in
    with abandoned as (
      update rt_sessions s
         set state        = 'terminal',
             outcome      = jsonb_build_object(
                              'kind', 'ended_without_outcome',
                              'reason', 'rejoin_window_expired',
                              'winner', null,
                              'recordedAt', (extract(epoch from p_now) * 1000)::bigint
                            ),
             paused_since = null,
             updated_at   = p_now
       where s.state = 'paused'
         and s.paused_since is not null
         -- REJOIN_WINDOW_MS = 5 minutes
         and s.paused_since <= p_now - interval '5 minutes'
      returning s.id, s.game_id, s.pairing_id
    )
    select * from abandoned
  loop
    select * into v_pairing from pairings where pairings.id = v_row.pairing_id;

    if found then
      v_notifications := v_notifications || jsonb_build_array(
        jsonb_build_object(
          'recipient', v_pairing.member_a,
          'category',  'system',
          'payload',   jsonb_build_object(
                         'kind', 'rt_session_ended',
                         'reason', 'rejoin_window_expired',
                         'sessionId', v_row.id,
                         'gameId', v_row.game_id
                       ),
          'dedupe_key', 'rt:pause_expired:' || v_row.id::text
        ),
        jsonb_build_object(
          'recipient', v_pairing.member_b,
          'category',  'system',
          'payload',   jsonb_build_object(
                         'kind', 'rt_session_ended',
                         'reason', 'rejoin_window_expired',
                         'sessionId', v_row.id,
                         'gameId', v_row.game_id
                       ),
          'dedupe_key', 'rt:pause_expired:' || v_row.id::text
        )
      );
    end if;

    return next v_row.id;
  end loop;

  if jsonb_array_length(v_notifications) > 0 then
    perform app.insert_derived_notifications(v_notifications, p_now);
  end if;
end;
$$;

comment on function public.terminate_abandoned_rt_pauses (timestamptz) is
  'Terminates paused real-time sessions past the 5-minute rejoin window as ended-without-outcome and notifies both partners (Req 6.10). Returns the ids it terminated.';

-- ===========================================================================
-- Requirement 7.12 — nudge a turn that has been pending 48 hours
-- ===========================================================================
-- CRITICAL: this function must NOT change session state in any way. Req 7.11 says
-- an asynchronous session stays active regardless of inactivity, and 7.12 says the
-- nudge must not terminate or forfeit it. So there is no UPDATE here at all — only
-- a SELECT and a notification insert. Any future edit that adds an UPDATE to this
-- function is a requirements violation, not an optimisation.
--
-- The dedupe key must match `deriveTurnNudge` in
-- packages/core/src/domain/async-lifecycle.ts EXACTLY:
--   `async_turn:turn_reminder:{sessionId}:{turnPendingSinceMs}`
-- so that a nudge derived client-side or by the turn path and one derived here
-- collapse to the same row (Req 11.6). `turn_pending_since` is written by the turn
-- path as a millisecond-precision ISO string, so the epoch-to-ms conversion below
-- reproduces the same integer.

create or replace function public.nudge_stale_async_turns (
  p_now timestamptz default now()
)
  returns setof uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_notifications jsonb := '[]'::jsonb;
  v_row           record;
begin
  for v_row in
    select s.id, s.game_id, s.active_turn_holder, s.turn_pending_since
      from async_sessions s
      join pairings p on p.id = s.pairing_id
     where s.state = 'active'
       -- Req 7.11: only a live pairing; a dissolved one already terminated its
       -- sessions, so this is belt-and-braces rather than load-bearing.
       and p.status = 'active'
       -- TURN_NUDGE_THRESHOLD_MS = 48 hours
       and s.turn_pending_since <= p_now - interval '48 hours'
  loop
    v_notifications := v_notifications || jsonb_build_array(
      jsonb_build_object(
        'recipient', v_row.active_turn_holder,
        'category',  'async_turn',
        'payload',   jsonb_build_object(
                       'kind', 'turn_reminder',
                       'sessionId', v_row.id,
                       'gameId', v_row.game_id,
                       'pendingSince', (extract(epoch from v_row.turn_pending_since) * 1000)::bigint
                     ),
        -- Matches deriveTurnNudge's key so the two never double-notify (Req 11.6).
        'dedupe_key', 'async_turn:turn_reminder:' || v_row.id::text || ':' ||
                      (extract(epoch from v_row.turn_pending_since) * 1000)::bigint::text
      )
    );

    return next v_row.id;
  end loop;

  if jsonb_array_length(v_notifications) > 0 then
    perform app.insert_derived_notifications(v_notifications, p_now);
  end if;
end;
$$;

comment on function public.nudge_stale_async_turns (timestamptz) is
  'Notifies the Active_Turn_Holder of a turn pending 48h WITHOUT terminating or forfeiting the session (Req 7.12). Deduped per pending turn (Req 11.6). Returns the ids it nudged.';

-- ===========================================================================
-- Lock down execution
-- ===========================================================================
-- Same posture as the other server-authoritative RPCs: no client role may invoke
-- these over the Data API. pg_cron runs them as the job owner (postgres), which is
-- unaffected by these grants.

revoke execute on function public.expire_pending_rt_sessions (timestamptz) from public;
revoke execute on function public.terminate_abandoned_rt_pauses (timestamptz) from public;
revoke execute on function public.nudge_stale_async_turns (timestamptz) from public;

grant execute on function public.expire_pending_rt_sessions (timestamptz) to service_role;
grant execute on function public.terminate_abandoned_rt_pauses (timestamptz) to service_role;
grant execute on function public.nudge_stale_async_turns (timestamptz) to service_role;

-- ===========================================================================
-- Schedules
-- ===========================================================================
-- Cadence is chosen so detection lag is small relative to each window rather than
-- uniformly aggressive:
--   * join expiry runs every 30s against a 60s deadline, so a cancelled
--     invitation is observed within ~90s of being sent.
--   * pause termination runs every minute against a 5-minute deadline.
--   * the nudge runs every 5 minutes against a 48-hour deadline; running it more
--     often would only scan the same rows.
--
-- Idempotent: unschedule-then-schedule so replaying this migration cannot leave
-- duplicate jobs firing the same function.

do $$
declare
  v_job text;
begin
  foreach v_job in array array[
    'ldr-rt-join-expiry',
    'ldr-rt-pause-termination',
    'ldr-async-turn-nudge'
  ] loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end $$;

select cron.schedule(
  'ldr-rt-join-expiry',
  '30 seconds',
  $$select public.expire_pending_rt_sessions(now())$$
);

select cron.schedule(
  'ldr-rt-pause-termination',
  '* * * * *',
  $$select public.terminate_abandoned_rt_pauses(now())$$
);

select cron.schedule(
  'ldr-async-turn-nudge',
  '*/5 * * * *',
  $$select public.nudge_stale_async_turns(now())$$
);

-- ===========================================================================
-- Schedule inspection
-- ===========================================================================
-- `cron.job` lives in the `cron` schema, which is not exposed by the Data API
-- (config.toml api.schemas = public, graphql_public), so neither an operator nor a
-- test can read it through PostgREST. This SECURITY DEFINER view over it closes
-- that gap: a correct function that is never scheduled is still a broken feature,
-- and without this the only way to verify the schedules exist is a shell into the
-- database container.
--
-- OUT parameters are named `job_*` rather than reusing `jobname` / `schedule` /
-- `active`: a `returns table` column is a variable in scope for the whole body and
-- would shadow the identically-named `cron.job` columns — the same ambiguity that
-- broke `accept_invitation` (fixed in migration 20260901000001).

create or replace function public.ldr_scheduled_jobs ()
  returns table (job_name text, job_schedule text, job_active boolean)
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  select j.jobname::text, j.schedule::text, j.active
    from cron.job j
   where j.jobname like 'ldr-%'
   order by j.jobname;
$$;

comment on function public.ldr_scheduled_jobs () is
  'Lists this application''s pg_cron schedules. Exists because the cron schema is not exposed by the Data API, so schedules would otherwise be unverifiable without database shell access.';

revoke execute on function public.ldr_scheduled_jobs () from public;
grant execute on function public.ldr_scheduled_jobs () to service_role;
