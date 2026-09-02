-- Feature: ldr-companion-app (fixes a gap behind Requirements 5.3, 9.1, 9.3)
--
-- Publishes the pairing-scoped shared-data tables to `supabase_realtime` so a
-- partner's committed change actually reaches the other partner's client.
--
-- THE GAP
-- -------
-- A Postgres Changes subscription only receives events for tables that are
-- members of the `supabase_realtime` publication. Migration 20260826062557 added
-- exactly two tables -- `async_sessions` and `notifications` -- because those were
-- what task 16.1 needed. Everything else was never added, so:
--
--   relationship_dates, reminders, rt_sessions, quiz_sessions
--
-- produced NO realtime events at all. Verified against a live stack: a client
-- subscribed to `pairing:{id}` with a `pairing_id=eq.{id}` filter received
-- nothing within 8 seconds of a committed `relationship_dates` write, and
-- received it in ~200ms once the table was published.
--
-- That breaks Requirement 5.3 ("propagate the change to the other Partner's
-- Authenticated_Session within 5 seconds") for every kind of shared data except
-- async turns and notifications, and with it Requirements 9.1/9.2/9.3 (date
-- create/edit/delete reaching both partners).
--
-- REPLICA IDENTITY, AND WHY IT IS NOT APPLIED UNIFORMLY
-- ----------------------------------------------------
-- Realtime applies the subscription's `filter` to the row in the WAL record. For
-- INSERT and UPDATE that is the NEW row, which carries `pairing_id`. For DELETE
-- there is only the OLD row, and under the default replica identity that record
-- contains ONLY the primary key -- so `pairing_id=eq.{id}` cannot match and the
-- delete is silently dropped. Confirmed on a live stack: with the default
-- identity a DELETE never arrived (8s), and with FULL it arrived in ~500ms.
--
-- So `replica identity full` is required wherever a user-initiated DELETE must
-- propagate. That is the calendar tables:
--   * relationship_dates -- Req 9.3, a deleted date disappears for both partners
--   * reminders          -- Req 10.4, deleting a date cancels its reminders
--
-- It is deliberately NOT applied to rt_sessions / async_sessions /
-- quiz_sessions. Those rows are never deleted by a user: they reach a terminal
-- state and are only removed by the pairing cascade, at which point the pairing
-- channel is gone anyway. Setting FULL there would log the entire OLD row on
-- every UPDATE, and `rt_sessions.game_state` is updated on every move -- pure WAL
-- amplification on the hottest write path in the system for an event no client
-- subscribes to.
--
-- Requirements: 5.3, 9.1, 9.2, 9.3, 10.4

-- ===========================================================================
-- Publication membership
-- ===========================================================================
-- Idempotent: `alter publication ... add table` errors if the table is already a
-- member, and this migration must be safe to replay against a database where
-- 20260826062557 already added its two tables.

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime is absent; skipping';
    return;
  end if;

  foreach v_table in array array[
    'relationship_dates',
    'reminders',
    'rt_sessions',
    'quiz_sessions',
    -- Restated for idempotency; added by 20260826062557.
    'async_sessions',
    'notifications'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

-- ===========================================================================
-- Replica identity for DELETE propagation
-- ===========================================================================
-- Only the tables whose rows a user can delete. See the reasoning above for why
-- the session tables are left on the default identity.

alter table public.relationship_dates replica identity full;
alter table public.reminders replica identity full;

comment on table public.relationship_dates is
  'Pairing-scoped relationship dates (Req 9). REPLICA IDENTITY FULL so DELETE events carry pairing_id and survive the Realtime pairing filter (Req 9.3).';
comment on table public.reminders is
  'Reminders attached to a relationship date (Req 10). REPLICA IDENTITY FULL so cascade DELETEs reach both partners (Req 10.4).';
