-- Migration: sync write-path HLC ordering + stale-write guard
-- Feature: ldr-companion-app (task 14.1)
--
-- Requirements: 5.2, 5.5, 5.6
--
-- The `sync-write` Edge Function is the server-authoritative write path for
-- shared data. It applies the pure, property-tested `resolveConflict` from
-- `@ldr/core` (Property 18) to decide whether an incoming HLC-stamped change
-- wins over the value already stored in the row's `hlc` column, and only then
-- issues the write (Req 5.5, 5.6).
--
-- That decision is a read-then-write, so on its own it has a race: two writers
-- that both read the same stored HLC could both proceed, and the row would end
-- up holding whichever write physically arrived last rather than the one with
-- the greater HLC. This migration closes that race in the database so the
-- invariant "a stale change never clobbers a newer value" holds no matter how
-- writes interleave:
--
--   * `app.hlc_cmp` is the SQL mirror of the core total order over HLC
--     timestamps (physical time, then counter, then originAccountId), and
--   * `app.hlc_guard` is a BEFORE UPDATE trigger that discards an update whose
--     incoming `hlc` is strictly older than the row's stored `hlc` by returning
--     OLD, leaving the newer stored row intact.
--
-- The guard only rejects STRICTLY older HLCs. Equal HLCs pass through, so the
-- other server-authoritative functions (game-move validation, quiz scoring,
-- schedulers) that update these rows without advancing `hlc` are unaffected.
--
-- Also adds the missing `hlc` column to `notification_settings`: it is
-- account-owned rather than pairing-synced, but it is still shared data that has
-- to converge across a user's mobile and desktop clients (Req 5.1, 5.2), so it
-- participates in the same last-write-wins write path.

-- ---------------------------------------------------------------------------
-- app.hlc_cmp: total order over HLC timestamps (mirrors @ldr/core compareHLC)
-- ---------------------------------------------------------------------------
-- Returns -1 when a < b, 1 when a > b, 0 when the two timestamps are equal.
-- A NULL `hlc` (row written before it joined the sync path) sorts oldest.
-- Missing/non-numeric components are treated as -1 so a malformed timestamp can
-- never sort ahead of a well-formed one; the Edge Function validates shape
-- before writing, so this is only a defensive floor.
create or replace function app.hlc_cmp (a jsonb, b jsonb)
  returns integer
  language plpgsql
  immutable
  parallel safe
as $$
declare
  a_physical numeric;
  b_physical numeric;
  a_counter  numeric;
  b_counter  numeric;
  a_origin   text;
  b_origin   text;
begin
  if a is null and b is null then
    return 0;
  elsif a is null then
    return -1;
  elsif b is null then
    return 1;
  end if;

  a_physical := case when jsonb_typeof(a -> 'physical') = 'number'
                  then (a ->> 'physical')::numeric else -1 end;
  b_physical := case when jsonb_typeof(b -> 'physical') = 'number'
                  then (b ->> 'physical')::numeric else -1 end;
  if a_physical <> b_physical then
    return case when a_physical < b_physical then -1 else 1 end;
  end if;

  a_counter := case when jsonb_typeof(a -> 'counter') = 'number'
                 then (a ->> 'counter')::numeric else -1 end;
  b_counter := case when jsonb_typeof(b -> 'counter') = 'number'
                 then (b ->> 'counter')::numeric else -1 end;
  if a_counter <> b_counter then
    return case when a_counter < b_counter then -1 else 1 end;
  end if;

  a_origin := coalesce(a ->> 'originAccountId', '');
  b_origin := coalesce(b ->> 'originAccountId', '');
  if a_origin <> b_origin then
    return case when a_origin < b_origin then -1 else 1 end;
  end if;

  return 0;
end;
$$;

comment on function app.hlc_cmp (jsonb, jsonb) is
  'Total order over HLC timestamps (physical, then counter, then originAccountId); SQL mirror of @ldr/core compareHLC (Req 5.5, 5.6).';

-- ---------------------------------------------------------------------------
-- app.hlc_guard: reject stale writes at the row level
-- ---------------------------------------------------------------------------
-- BEFORE UPDATE trigger for every shared table that carries an `hlc` column.
-- Returning OLD discards the whole incoming row version, so a stale offline
-- change cannot clobber a newer value even if it passed the Edge Function's
-- check and then lost a race (Req 5.5).
create or replace function app.hlc_guard ()
  returns trigger
  language plpgsql
as $$
begin
  if new.hlc is not null
     and old.hlc is not null
     and app.hlc_cmp(new.hlc, old.hlc) < 0 then
    return old;
  end if;
  return new;
end;
$$;

comment on function app.hlc_guard () is
  'BEFORE UPDATE guard: discards an update whose incoming hlc is strictly older than the stored hlc (Req 5.5).';

-- ---------------------------------------------------------------------------
-- notification_settings joins the HLC write path
-- ---------------------------------------------------------------------------
alter table notification_settings
  add column if not exists hlc jsonb;

comment on column notification_settings.hlc is
  'Hybrid logical clock { physical, counter, originAccountId } for LWW convergence across the account''s own clients (Req 5.1, 5.2).';

-- ---------------------------------------------------------------------------
-- Attach the guard to every hlc-carrying shared table
-- ---------------------------------------------------------------------------
create trigger rt_sessions_hlc_guard
  before update on rt_sessions
  for each row execute function app.hlc_guard ();

create trigger async_sessions_hlc_guard
  before update on async_sessions
  for each row execute function app.hlc_guard ();

create trigger quiz_sessions_hlc_guard
  before update on quiz_sessions
  for each row execute function app.hlc_guard ();

create trigger quiz_self_answers_hlc_guard
  before update on quiz_self_answers
  for each row execute function app.hlc_guard ();

create trigger quiz_guesses_hlc_guard
  before update on quiz_guesses
  for each row execute function app.hlc_guard ();

create trigger relationship_dates_hlc_guard
  before update on relationship_dates
  for each row execute function app.hlc_guard ();

create trigger reminders_hlc_guard
  before update on reminders
  for each row execute function app.hlc_guard ();

create trigger notification_settings_hlc_guard
  before update on notification_settings
  for each row execute function app.hlc_guard ();
