# Implementation Plan: LDR Companion App

## Overview

This plan implements the LDR Companion App on Supabase (Postgres + RLS, Auth/GoTrue, Realtime, Storage, Edge Functions, pg_cron) with a shared TypeScript client core wrapped by Expo (mobile) and Electron/web (desktop) shells.

The sequencing is deliberately test-driven where practical: scaffolding and schema come first, then the **pure, deterministic domain helpers** (validation, HLC conflict resolution, move/turn engines, quiz scoring, date ordering, reminder scheduling, delivery eligibility) are implemented alongside their **`fast-check` property-based tests** (minimum 100 iterations each, tagged `// Feature: ldr-companion-app, Property {n}: {text}`). Only then are the server-authoritative Edge Functions, Realtime wiring, scheduler jobs, client service modules, and platform shells built on top of the verified logic. Every one of the 11 requirements and all 41 correctness properties is covered by at least one task below.

## Tasks

- [x] 1. Project scaffolding and shared core foundation
  - [x] 1.1 Initialize monorepo with shared TS core package and platform shells
    - Create a workspace monorepo containing `packages/core` (shared TypeScript domain + `supabase-js` service modules), `apps/mobile` (React Native/Expo), and `apps/desktop` (Electron/web)
    - Configure TypeScript, module resolution, and shared build/lint tooling across packages
    - _Requirements: 5.1_

  - [x] 1.2 Set up Supabase local dev environment and test harness
    - Add Supabase CLI config (`supabase/` with `config.toml`), local `supabase start` stack, and an Edge Functions (Deno) project skeleton
    - Install and configure `fast-check` for the core package and a test runner for unit + property + integration suites
    - _Requirements: 5.1_

  - [x] 1.3 Define shared domain types, Result type, and error vocabulary
    - Implement the `Result<T, E>` type, shared entity/interface types (Account, Pairing, sessions, quiz, dates, reminders, notifications, `HLCTimestamp`, `Answer`), and stable machine-readable error codes
    - _Requirements: 5.1, 5.2_

- [x] 2. Database schema and Row Level Security
  - [x] 2.1 Write migrations for account, session, and pairing tables
    - Create migrations for `accounts`, `account_session` (epoch registry), `auth_attempts` (lockout), `invitations` (72h expiry, single-use), and `pairings` with a partial UNIQUE index on active membership
    - _Requirements: 1.1, 2.3, 2.6, 2.7, 3.1, 3.6, 3.8_

  - [x] 2.2 Write migrations for game, quiz, calendar, and notification tables
    - Create migrations for `rt_sessions`, `async_sessions`, `quiz_defs`/`quiz_questions` (FK enforcing one quiz per question), `quiz_sessions` (partial UNIQUE active-per-pairing), `quiz_self_answers`, `quiz_guesses`, `relationship_dates`, `reminders` (`ON DELETE CASCADE`), `notifications`, and `notification_settings`; add the `hlc` column to shared-data rows
    - _Requirements: 6.2, 7.2, 8.2, 8.9, 8.11, 9.1, 10.1, 10.4, 11.4_

  - [x] 2.3 Implement RLS policies and Storage bucket policies
    - Enable RLS on all account-scoped and pairing-scoped tables; add pairing-scope predicate (`pairing_id = current_pairing(auth.uid())`), recipient-scope predicate for notifications, the quiz self-answer withholding policy keyed on session phase, the epoch guard for the single-session invariant, and private Storage bucket policies for drawing images
    - _Requirements: 2.5, 2.7, 2.8, 2.9, 4.4, 8.4_

  - [x] 2.4 Write RLS integration tests
    - Using two authenticated test users on the local stack, assert cross-pairing rows are unreadable, a former partner loses pairing-data access after dissolution, self-answers are non-selectable by the partner during the self-answer phase but selectable afterward, and Storage blocks cross-pairing image access
    - Passing against a live stack (`npm run test:integration:local`). Required fixing a defect in task 2.3 first: `service_role` had no DML privileges on the app tables, because the `ALTER DEFAULT PRIVILEGES` entry for owner `postgres` in schema `public` grants no DML and `20260826062549` granted DML explicitly to `authenticated` only. Fixed in migration `20260901000000_service_role_table_grants.sql`.
    - _Requirements: 4.4, 8.4_

- [x] 3. Authentication domain logic (pure helpers)
  - [x] 3.1 Implement credential validation helpers
    - Implement `validatePasswordPolicy` (12–128 chars; requires upper, lower, digit, non-alphanumeric; reports each unmet criterion and missing-field cases) and `validateEmailFormat`
    - _Requirements: 1.1, 1.3, 1.4, 1.5_

  - [x] 3.2 Write property test for password policy
    - **Property 1: Password policy reports every unmet criterion**
    - **Validates: Requirements 1.1, 1.3, 1.5** (exercise boundary lengths 11/12/128/129)

  - [x] 3.3 Write property test for email format validation
    - **Property 2: Email format validation**
    - **Validates: Requirements 1.4**

  - [x] 3.4 Implement hashing, lockout, session-epoch, and inactivity helpers
    - Implement a password hash/verify wrapper over bcrypt, a pure `computeLockout` evaluator (5 consecutive failures within 15 min → locked 15 min), a pure session-validity evaluator over the epoch registry (only the latest epoch is valid), and a pure inactivity evaluator (valid iff last-activity delta < 30 days)
    - _Requirements: 1.6, 2.3, 2.6, 2.7, 2.8_

  - [x] 3.5 Write property test for password hashing
    - **Property 4: Password hashing round-trip and secrecy**
    - **Validates: Requirements 1.6**

  - [x] 3.6 Write property test for account lockout
    - **Property 7: Account lockout after 5 failures in 15 minutes**
    - **Validates: Requirements 2.3**

  - [x] 3.7 Write property test for single active session invariant
    - **Property 8: Single active session invariant**
    - **Validates: Requirements 2.5, 2.7, 2.8, 2.9**

  - [x] 3.8 Write property test for session inactivity expiry
    - **Property 9: Session inactivity expiry**
    - **Validates: Requirements 2.6**

- [x] 4. Sync domain logic (HLC and offline queue)
  - [x] 4.1 Implement HLC clock and resolveConflict
    - Implement the hybrid logical clock (`{ physical, counter, originAccountId }`) and `resolveConflict` (last-write-wins by physical time, then counter, then origin account id; symmetric on ties)
    - _Requirements: 5.5, 5.6_

  - [x] 4.2 Write property test for conflict resolution
    - **Property 18: Last-write-wins conflict resolution is deterministic and convergent**
    - **Validates: Requirements 5.5, 5.6** (exercise identical HLC timestamps)

  - [x] 4.3 Implement the offline sync queue
    - Implement the local sync queue that retains HLC-stamped changes in submission order while offline and preserves them until drained
    - _Requirements: 5.4_

  - [x] 4.4 Write property test for offline queue integrity
    - **Property 17: Offline changes are queued without loss**
    - **Validates: Requirements 5.4**

- [x] 5. Real-time game engine logic (pure)
  - [x] 5.1 Implement applyMove engine and concrete game rulesets
    - Implement the pure `applyMove(state, actor, move)` returning updated state on valid moves and an unchanged-state rejection on invalid moves, plus at least one concrete real-time game ruleset plugging into the engine
    - _Requirements: 6.4, 6.11_

  - [x] 5.2 Write property test for the move engine
    - **Property 20: Real-time move engine correctness**
    - **Validates: Requirements 6.4, 6.11**

  - [x] 5.3 Implement join transition, pause/rejoin, and terminal-outcome state logic
    - Implement pure state transitions: pending→active with identical initial state when both join within 60s; pause preserves state on disconnect and rejoin within 5 min restores it; terminal state records an outcome
    - _Requirements: 6.3, 6.6, 6.7, 6.8_

  - [x] 5.4 Write property test for join transition
    - **Property 22: Real-time join transition produces identical active state**
    - **Validates: Requirements 6.3**

  - [x] 5.5 Write property test for pause/rejoin state preservation
    - **Property 21: Pause preserves and rejoin restores real-time state**
    - **Validates: Requirements 6.6, 6.7**

  - [x] 5.6 Write property test for terminal outcome
    - **Property 23: Real-time terminal outcome is recorded and presented**
    - **Validates: Requirements 6.8**

- [x] 6. Asynchronous game engine logic (pure)
  - [x] 6.1 Implement applyTurn engine and concrete rulesets
    - Implement the pure `applyTurn(state, holder, action)` that records a valid holder turn, updates state, and transfers the Active_Turn_Holder; rejects non-holder or invalid turns leaving state and holder unchanged; add Battleship and drawing-game rulesets
    - _Requirements: 7.4, 7.5, 7.7, 7.8_

  - [x] 6.2 Write property test for the turn engine
    - **Property 24: Asynchronous turn engine correctness**
    - **Validates: Requirements 7.4, 7.5, 7.7, 7.8**

  - [x] 6.3 Implement inactivity/nudge and turn-handoff notification derivation
    - Implement pure logic: a session with no terminal state and an undissolved pairing stays active regardless of inactivity; a 48h-pending turn produces a nudge without forfeiting; a completed valid turn derives a your-turn notification for the new holder
    - _Requirements: 7.6, 7.11, 7.12_

  - [x] 6.4 Write property test for persistence through inactivity
    - **Property 25: Asynchronous session persists through inactivity**
    - **Validates: Requirements 7.11, 7.12**

  - [x] 6.5 Write property test for turn hand-off notification
    - **Property 41: Turn hand-off notification**
    - **Validates: Requirements 7.6**

- [x] 7. Quiz domain logic (pure)
  - [x] 7.1 Implement answer validation and scoring helpers
    - Implement `validateAnswer` (MC: one offered choice; SA: non-empty 1–100 chars), `answersMatch` (MC identical choice; SA trim + case-insensitive), and `scoreSession` (one point per matching guess)
    - _Requirements: 8.3, 8.7, 8.12, 8.13_

  - [x] 7.2 Write property test for answer/guess validation
    - **Property 29: Quiz answer and guess submission validation**
    - **Validates: Requirements 8.3, 8.6, 8.12, 8.13** (exercise whitespace-only and 100-char boundary text)

  - [x] 7.3 Write property test for scoring
    - **Property 31: Quiz scoring matches per answer type**
    - **Validates: Requirements 8.7**

  - [x] 7.4 Implement quiz session state machine, catalog integrity, and self-answer view redaction
    - Implement pure logic for initial session state (self-answer phase, no answers/guesses, zero scores), phase progression (→guessing when both answered all; →complete when both guessed all, with full results), one-active-session-per-pairing rejection, catalog integrity (each question in exactly one quiz), and a serialized-view builder that redacts the other partner's self-answers during the self-answer phase
    - _Requirements: 8.2, 8.4, 8.5, 8.8, 8.9, 8.11_

  - [x] 7.5 Write property test for initial quiz state
    - **Property 26: Quiz session initial state**
    - **Validates: Requirements 8.2**

  - [x] 7.6 Write property test for single active quiz session
    - **Property 27: Only one active quiz session per pairing**
    - **Validates: Requirements 8.11**

  - [x] 7.7 Write property test for phase progression
    - **Property 30: Quiz phase progression**
    - **Validates: Requirements 8.5, 8.8**

  - [x] 7.8 Write property test for self-answer withholding in the serialized view
    - **Property 28: Quiz self-answers are withheld during the self-answer phase**
    - **Validates: Requirements 8.4**

  - [x] 7.9 Write property test for question-to-quiz uniqueness
    - **Property 32: Each quiz question belongs to exactly one quiz**
    - **Validates: Requirements 8.9**

- [x] 8. Calendar and reminder domain logic (pure)
  - [x] 8.1 Implement date and reminder helpers
    - Implement `validateTitle` (non-empty after trim, 1–100 chars), `isValidCalendarDate`, `orderDates` (next occurrence asc, then case-insensitive title), `nextOccurrence`, and `reminderTriggerTime` (occurrence minus lead time; lead time 1 min–365 days resolving to a future time)
    - _Requirements: 9.4, 9.5, 9.7, 10.1, 10.2_

  - [x] 8.2 Write property test for date validation
    - **Property 34: Relationship date validation**
    - **Validates: Requirements 9.4, 9.5, 9.6**

  - [x] 8.3 Write property test for date ordering
    - **Property 35: Relationship date ordering**
    - **Validates: Requirements 9.7**

  - [x] 8.4 Write property test for reminder scheduling/validation
    - **Property 36: Reminder scheduling and validation**
    - **Validates: Requirements 10.1, 10.2** (exercise 1-minute and 365-day boundaries)

  - [x] 8.5 Implement date persistence model, cascade cancel, and recurring reschedule
    - Implement pure operations for create/edit/delete over a pairing's date set (with not-found rejection), reminder cancellation when a date is deleted, and rescheduling a recurring date's reminder at the same lead time before the next future occurrence on delivery
    - _Requirements: 9.1, 9.2, 9.3, 9.6, 10.4, 10.5_

  - [x] 8.6 Write property test for date persistence round-trip
    - **Property 33: Relationship date persistence round-trip**
    - **Validates: Requirements 9.1, 9.2, 9.3**

  - [x] 8.7 Write property test for delete cancels reminders
    - **Property 37: Deleting a date cancels its reminders**
    - **Validates: Requirements 10.4**

  - [x] 8.8 Write property test for recurring reminder reschedule
    - **Property 38: Recurring reminders reschedule on delivery**
    - **Validates: Requirements 10.5**

- [x] 9. Notification domain logic (pure)
  - [x] 9.1 Implement delivery eligibility helpers
    - Implement `shouldDeliver` (category enabled and not acknowledged), `isExpired` (created > 30 days ago), and dedupe-key handling
    - _Requirements: 11.3, 11.4, 11.5, 11.6_

  - [x] 9.2 Write property test for notification delivery eligibility
    - **Property 39: Notification delivery eligibility**
    - **Validates: Requirements 11.3, 11.4, 11.5, 11.6**

- [x] 10. Pairing domain logic (pure)
  - [x] 10.1 Implement invitation, exclusivity, acceptance, dissolution, and require-pairing logic
    - Implement pure logic for invitation creation/expiry (creation + 72h) and single-use consumption, exclusivity checks (reject invite/accept originating from or targeting an already-paired account, state unchanged), valid acceptance within window creating the pairing, dissolution (unpair both, retain individual data, revoke pairing data, terminate active sessions, produce pairing-ended notifications), and a shared `requirePairing` guard for session/quiz starts
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.5, 7.9, 8.10_

  - [x] 10.2 Write property test for pairing exclusivity
    - **Property 10: Pairing exclusivity invariant**
    - **Validates: Requirements 3.3, 3.4, 3.6, 3.7**

  - [x] 10.3 Write property test for valid acceptance
    - **Property 11: Valid acceptance within window creates the pairing**
    - **Validates: Requirements 3.2**

  - [x] 10.4 Write property test for invitation validity window
    - **Property 12: Invitation validity window and expiry**
    - **Validates: Requirements 3.1, 3.5**

  - [x] 10.5 Write property test for single-use invitation
    - **Property 13: Invitation is single-use**
    - **Validates: Requirements 3.8**

  - [x] 10.6 Write property test for dissolution effects
    - **Property 14: Dissolution unpairs, retains individual data, revokes pairing data**
    - **Validates: Requirements 4.1, 4.3, 4.4**

  - [x] 10.7 Write property test for dissolution terminating active sessions
    - **Property 15: Dissolution terminates any active session**
    - **Validates: Requirements 4.6**

  - [x] 10.8 Write property test for pairing-ended notification delivery/deferral
    - **Property 40: Pairing-ended notification is delivered or deferred**
    - **Validates: Requirements 4.2, 4.5**

  - [x] 10.9 Write property test for require-pairing on session start
    - **Property 19: Starting a session requires a pairing**
    - **Validates: Requirements 6.5, 7.9, 8.10**

- [x] 11. Checkpoint - pure domain logic complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Authentication Edge Functions and single-session enforcement
  - [x] 12.1 Implement the registration Edge Function
    - Run `validatePasswordPolicy`/`validateEmailFormat`, reject missing fields, then call Supabase Auth admin `createUser` (email uniqueness + bcrypt), placing the account in an unpaired state and returning within 5s
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 12.2 Implement login epoch hook, epoch guard, and revoke signal
    - On successful `signInWithPassword`, increment `account_session.epoch`, embed the epoch claim, broadcast a revoke on the per-account Realtime channel to displace the prior client, and enforce the epoch guard so stale-epoch requests are denied; return uniform non-revealing auth errors
    - _Requirements: 2.1, 2.2, 2.7, 2.8, 2.9_

  - [x] 12.3 Implement lockout recording and inactivity handling
    - Record failures in `auth_attempts`, set `locked_until`, and wire sign-out session termination and `last_activity_at` updates that back the 30-day inactivity expiry
    - _Requirements: 2.3, 2.4, 2.5, 2.6_

  - [x] 12.4 Write auth integration tests
    - Assert duplicate-email rejection (**Property 3**), correct/incorrect credential outcomes (**Property 5**), indistinguishable failure error (**Property 6**), and that a second login displaces the first and a stale-epoch token is denied within 5s (**Property 8**)
    - Passing against a live stack. Property 8 was mutation-checked (stubbing `app.session_epoch_ok` to `true` makes it fail), so it is not vacuous. Note the epoch guard withholds **shared** features only, per Req 2.9 — a displaced client can still read its own `account_session` row, which is what lets it observe the new epoch and route itself to sign-in.
    - _Requirements: 1.2, 2.1, 2.2, 2.8, 2.9_

- [ ] 13. Pairing Edge Functions
  - [x] 13.1 Implement createInvitation and acceptInvitation
    - `createInvitation` (reject if already paired) issues a unique 72h invitation row; `acceptInvitation` runs a Postgres transaction that rejects expired/already-paired accounts, consumes the single-use invitation, and creates the pairing guarded by the partial UNIQUE index
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [-] 13.2 Implement the unlink Edge Function
    - Dissolve the pairing, clear both accounts' `pairingId`, terminate active game/quiz sessions, and insert pairing-ended notifications for both partners within 5s
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 13.3 Write pairing Edge Function integration tests
    - Assert concurrent double-accept cannot both succeed (**Property 10**), a consumed invitation cannot be reused (**Property 13**), and unlink terminates an active session with notifications (**Property 15**)
    - Passing against a live stack (6 tests). Writing these found that `accept_invitation` raised on every call, so pairing had never worked — fixed in migration `20260901000001`. Mutation-checked by dropping the partial UNIQUE membership indexes and stripping the RPC's guards: that revealed the Edge-Function-level concurrency test passes even with no database guard, because the pure pre-check masks the race. A second test drives the RPC directly so the row locks and UNIQUE indexes are the only thing preventing a double pairing.
    - _Requirements: 3.6, 3.8, 4.6_

- [ ] 14. Sync wiring (write path + Realtime + reconnect)
  - [-] 14.1 Implement the write-path Edge Function applying resolveConflict
    - Apply `resolveConflict` server-side on shared-data writes using HLC, persist committed changes, and reject stale offline writes from clobbering newer values
    - _Requirements: 5.2, 5.5, 5.6_

  - [x] 14.2 Implement Postgres Changes subscription, connectivity indicator, and queue drain
    - Wire the Connection Manager to subscribe to pairing-scoped Postgres Changes (partner update <5s), show the connectivity-lost indicator offline, and drain the sync queue within 10s of reconnection
    - Implemented in `packages/core/src/sync/` as `connectivity.ts` (pure online/offline state machine + indicator), `sync-module.ts` (subscription, queue-vs-send, reconnect drain) and `supabase-ports.ts` (thin `supabase-js` adapter). 26 unit tests. The module takes injected ports rather than a `SupabaseClient` so the orchestration edges are testable without a stack, and so **task 21.3 composes these pieces rather than rewriting them** — 21.3 still owns Broadcast, Presence, and displacement sign-out. Remote changes are handed to an `onRemoteChange` listener rather than cached, leaving the Local Store to task 21.2. The <5s and 10s timings are integration assertions, owned by task 14.3.
    - _Requirements: 5.3, 5.4, 5.5_

  - [x] 14.3 Write sync integration tests
    - Assert partner receives a committed change via Postgres Changes within 5s, the queue drains within 10s applying `resolveConflict`, and committed changes survive across sessions (**Property 16**)
    - Passing against a live stack (7 tests); propagation measured at ~1s against the 5s budget. Writing these found that only `async_sessions` and `notifications` were in the `supabase_realtime` publication, so dates/reminders/sessions emitted no events at all — fixed in migration `20260901000002`, which also sets `REPLICA IDENTITY FULL` on the calendar tables because a DELETE's old row otherwise carries only the primary key and cannot match the pairing filter. Mutation-checked by dropping `relationship_dates` from the publication: both Realtime tests fail. Integration project now has a 60s outer timeout, since a test asserting a 5s budget cannot be killed by the runner at exactly 5s.
    - _Requirements: 5.2, 5.3, 5.5_

- [ ] 15. Real-time game wiring
  - [-] 15.1 Implement move-validation Edge Function and Broadcast fan-out
    - Validate moves authoritatively with `applyMove`, persist authoritative state, and fan out over a Realtime Broadcast channel for <2s reflection; reject invalid moves with state unchanged; enforce `requirePairing`
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.11_

  - [-] 15.2 Implement Presence-based disconnect/pause and rejoin
    - Use Presence on the game channel to detect 30s disconnect → pause + notify remaining partner + preserve state; resume from preserved state on rejoin within 5 min; present recorded outcome on terminal state
    - Server side is implemented (`rt-presence`, `rt-rejoin`). Remaining: the CLIENT half that tracks Presence and produces the snapshot, which belongs to the Connection Manager in task 21.3 — until then the function trusts a client-supplied snapshot and re-validates it server-side. Terminating a pause that is never rejoined is task 20.1.
    - _Requirements: 6.6, 6.7, 6.8_

  - [x] 15.3 Write real-time game integration tests
    - Assert a Broadcast move reflects within 2s, invitation notification within 5s, and Presence disconnect pauses the game after 30s
    - Passing against a live stack (7 tests). Measured: move fan-out ~35ms against the 2s budget, invite ~35ms against 5s. Also covers Req 6.1/6.3/6.5/6.7/6.11 and an outsider's presence report being refused as `SESSION_NOT_FOUND` (not-found rather than forbidden, so other pairings are not probeable). Mutation-checked twice: setting `DISCONNECT_THRESHOLD_MS` to 0 fails the pause test, and short-circuiting `rt-move`'s rejection branch fails the invalid-move test.
    - _Requirements: 6.2, 6.4, 6.6_

- [ ] 16. Asynchronous game wiring
  - [-] 16.1 Implement takeTurn Edge Function with turn transfer transaction
    - Validate the actor is the Active_Turn_Holder and the turn is valid via `applyTurn`, commit new state and transfer ownership in one transaction, and surface the change plus your-turn notification via Postgres Changes; enforce `requirePairing`
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

  - [ ] 16.2 Implement Storage bucket for drawing images
    - Create a pairing-scoped private Storage bucket and wire upload/read of drawing-game images referenced by async game state
    - _Requirements: 7.3_

  - [ ] 16.3 Write asynchronous game integration tests
    - Assert a non-holder turn is rejected with state unchanged, a valid turn transfers ownership and notifies the other partner, and the terminal outcome is delivered/deferred to an offline partner
    - _Requirements: 7.5, 7.7, 7.10_

- [ ] 17. Quiz wiring
  - [ ] 17.1 Implement quiz submission and scoring Edge Function
    - Handle `startSession` (partial-UNIQUE one-active-per-pairing), `submitSelfAnswer`/`submitGuess` (validation, retain prior on reject), phase transitions, and `scoreSession`; enforce `requirePairing`
    - _Requirements: 8.2, 8.3, 8.5, 8.6, 8.7, 8.8, 8.10, 8.11, 8.12, 8.13_

  - [ ] 17.2 Wire the client quiz module with RLS-backed withholding
    - Implement the client `QuizModule` reading through RLS so the partner's self-answers are non-selectable during the self-answer phase and results (self-answers, guesses, scores) surface on completion
    - _Requirements: 8.1, 8.4, 8.8_

  - [ ] 17.3 Write quiz integration tests
    - Assert the RLS policy withholds self-answers during the self-answer phase and reveals them in the guessing/complete phase (**Property 28**), and that scoring/results are correct end to end
    - _Requirements: 8.4, 8.7, 8.8_

- [ ] 18. Calendar and reminder wiring
  - [ ] 18.1 Implement date create/edit/delete writes with Postgres Changes
    - Wire pairing-scoped date create/edit/delete through RLS-guarded writes (validation re-run server-side, not-found rejection) propagating to both partners within 5s, and list dates via `orderDates`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [ ] 18.2 Implement setReminder and reminder scheduling rows
    - Persist reminders with `nextTriggerAt` from `reminderTriggerTime` (reject out-of-range/non-future), cascade-delete with their date, and reschedule recurring reminders on delivery
    - _Requirements: 10.1, 10.2, 10.4, 10.5_

  - [ ] 18.3 Write calendar/reminder integration tests
    - Assert create/edit/delete propagate within 5s, invalid title/date/lead-time are rejected with no change, and deleting a date cascades reminder cancellation
    - _Requirements: 9.1, 9.4, 10.2, 10.4_

- [ ] 19. Notification wiring
  - [ ] 19.1 Implement in-app notifications, acknowledgement, and settings
    - Wire the recipient-scoped `notifications` Realtime subscription (pairing/game invites <5s), `acknowledge` (mark delivered + suppress re-delivery), undelivered retrieval within the 30-day window using `shouldDeliver`/`isExpired`, and category settings
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6_

  - [ ] 19.2 Implement push dispatch Edge Function
    - Dispatch best-effort out-of-app push to Expo Push (mobile) and the desktop notification API from an Edge Function, on top of the durable notifications table
    - _Requirements: 11.1, 11.2_

  - [ ] 19.3 Write notification integration tests
    - Assert pairing-invite and game-invite notifications arrive within 5s, disabled categories are withheld, and acknowledged notifications are not re-delivered
    - _Requirements: 11.1, 11.2, 11.3, 11.6_

- [ ] 20. Scheduler (pg_cron + scheduled Edge Functions)
  - [ ] 20.1 Implement game-related cron jobs
    - Create pg_cron jobs invoking Edge Functions for 60s real-time invitation-join expiry (cancel + notify), 5-min pause termination (end-without-outcome + notify), and 48h async turn nudge (notify without forfeiting)
    - _Requirements: 6.9, 6.10, 7.12_

  - [ ] 20.2 Implement reminder, inactivity, and retention cron jobs
    - Create pg_cron jobs for reminder delivery within 60s of trigger (defer offline), 30-day session inactivity revocation, and 30-day notification retention/discard
    - _Requirements: 2.6, 10.3, 11.4, 11.5_

  - [ ] 20.3 Write scheduler integration tests
    - Assert 60s join expiry, 5-min pause termination, 48h nudge, reminder delivery within 60s, and 30-day inactivity/retention windows fire as expected
    - _Requirements: 6.9, 6.10, 7.12, 10.3, 11.5_

- [ ] 21. Client service modules and Connection Manager
  - [ ] 21.1 Wire AuthenticationModule and PairingModule
    - Implement client `AuthenticationModule` (register/authenticate/signOut/currentSession, no-session routing to sign-in) and `PairingModule` (createInvitation/acceptInvitation/unlink/getPairing) over `supabase-js` and the Edge Functions
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.2, 4.1_

  - [ ] 21.2 Wire game, quiz, calendar, and notification client modules with Local Store
    - Implement `RealTimeGameModule`, `AsyncGameModule`, `CalendarModule`, and `NotificationModule` client-side with the Local Store cache for instant/offline reads and list presentation to both partners
    - _Requirements: 5.1, 6.1, 7.1, 8.1, 9.7_

  - [ ] 21.3 Implement Connection Manager channels, reconnect, and displacement sign-out
    - Maintain Realtime subscriptions (Postgres Changes, Broadcast, Presence), handle reconnect and queue drain, and force local sign-out when the per-account revoke signal arrives
    - _Requirements: 2.9, 5.3, 5.4, 6.6_

- [ ] 22. Platform shells
  - [ ] 22.1 Build the Expo mobile shell
    - Implement mobile navigation/UI over the shared modules, Expo SecureStore for the refresh token, and Expo Push registration writing the token to notification settings
    - _Requirements: 5.1, 11.1_

  - [ ] 22.2 Build the Electron/web desktop shell
    - Implement desktop UI over the shared modules, Electron `safeStorage`/OS keychain for the refresh token, and desktop notification integration
    - _Requirements: 5.1, 11.1_

  - [ ] 22.3 Write cross-platform parity tests
    - Load identical account/shared state through the mobile and desktop shells and assert presentation equality
    - _Requirements: 5.1_

- [ ] 23. Final integration and end-to-end wiring
  - [ ] 23.1 Wire all modules into both shells end to end
    - Connect auth, pairing, sync, games, quizzes, calendar, reminders, and notifications into both shells with no orphaned code; verify game/quiz/date list presentation to both partners
    - _Requirements: 5.1, 6.1, 7.1, 8.1_

  - [ ] 23.2 Write security and privacy tests
    - Assert self-answers never appear in a partner's response during the self-answer phase, a former partner cannot read pairing-owned data after dissolution, and error/RLS responses contain no sensitive data or existence leaks
    - _Requirements: 4.4, 8.4, 1.6_

- [ ] 24. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific granular requirements for traceability; every one of the 11 requirements and all 41 correctness properties is covered.
- Pure domain helpers and their `fast-check` property tests (min 100 iterations, tagged `// Feature: ldr-companion-app, Property {n}: {text}`) are implemented before the Supabase wiring so logic is verified before integration.
- Properties additionally enforced by RLS/constraints (8, 10, 14, 28) are re-verified at the integration layer; timing/latency criteria (5.3, 6.4, 10.3, 11.1, 11.2) are covered by integration tests, not properties.
- Checkpoints ensure incremental validation at natural breaks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1", "3.4", "4.1", "4.3", "5.1", "5.3", "6.1", "6.3", "7.1", "7.4", "8.1", "8.5", "9.1", "10.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "3.3", "3.5", "3.6", "3.7", "3.8", "4.2", "4.4", "5.2", "5.4", "5.5", "5.6", "6.2", "6.4", "6.5", "7.2", "7.3", "7.5", "7.6", "7.7", "7.8", "7.9", "8.2", "8.3", "8.4", "8.6", "8.7", "8.8", "9.2", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "10.8", "10.9"] },
    { "id": 4, "tasks": ["2.3"] },
    { "id": 5, "tasks": ["2.4", "12.1", "12.2", "12.3", "13.1", "13.2", "14.1", "15.1", "15.2", "16.1", "16.2", "17.1", "18.1", "18.2", "19.1", "19.2", "20.1", "20.2"] },
    { "id": 6, "tasks": ["12.4", "13.3", "14.2", "15.3", "16.3", "17.2", "18.3", "19.3", "20.3"] },
    { "id": 7, "tasks": ["14.3", "17.3", "21.1", "21.2", "21.3"] },
    { "id": 8, "tasks": ["22.1", "22.2", "23.1"] },
    { "id": 9, "tasks": ["22.3", "23.2"] }
  ]
}
```
