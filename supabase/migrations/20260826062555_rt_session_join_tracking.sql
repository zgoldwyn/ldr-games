-- Migration: track which partners have joined a pending real-time session
-- Feature: ldr-companion-app (task 15.1)
--
-- Requirements: 6.2, 6.3
--
-- The real-time session lifecycle (`pending -> active`) activates only once BOTH
-- partners have joined inside the 60-second window (Req 6.3). The authoritative
-- `pending -> active` decision lives in the pure `joinSession` transition
-- (packages/core/src/domain/rt-session.ts), which needs the set of partners that
-- are already present. `rt_sessions` had nowhere to record that set, so the
-- rt-move Edge Function persists it here.
--
-- The inviting partner is recorded at invite time (Req 6.2), so
-- `joined_accounts[1]` is the inviter — the Edge Function uses it as the partner
-- who moves first when seeding the identical initial game state.
--
-- Presence on the game channel (task 15.2) remains the live connectivity signal;
-- this column is only the durable record of who has joined.

alter table rt_sessions
  add column joined_accounts uuid[] not null default '{}';

comment on column rt_sessions.joined_accounts is
  'Accounts that have joined this session; both partners present => active (Req 6.3). First element is the inviter (Req 6.2).';
