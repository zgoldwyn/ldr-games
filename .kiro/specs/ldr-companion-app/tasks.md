# Implementation Plan: LDR Companion App

## Overview

This plan implements the LDR Companion App on Supabase (Postgres + RLS, Auth/GoTrue, Realtime, Storage, Edge Functions, pg_cron) with a shared TypeScript client core wrapped by Expo (mobile) and Electron/web (desktop) shells.

The sequencing is deliberately test-driven where practical: scaffolding and schema come first, then the **pure, deterministic domain helpers** (validation, HLC conflict resolution, move/turn engines, quiz scoring, date ordering, reminder scheduling, delivery eligibility) are implemented alongside their **`fast-check` property-based tests** (minimum 100 iterations each, tagged `// Feature: ldr-companion-app, Property {n}: {text}`). Only then are the server-authoritative Edge Functions, Realtime wiring, scheduler jobs, client service modules, and platform shells built on top of the verified logic. Every one of the 12 requirements and all 44 correctness properties is covered by at least one task below.

## MVP Scope

The plan was written backend-first, and that worked: auth, pairing, sync, real-time games, asynchronous games, and Storage are all implemented **and verified against a live stack**. But it left the project with a well-tested API and no app — every user-facing task is still unbuilt.

To correct that, the remaining work is now split into an **MVP path** and **deferred** sections. Tasks on the MVP path are marked `[MVP]`; deferred sections are marked `[DEFERRED]` with a note on what the deferral actually costs.

**MVP definition:** sign in on an iPhone, pair with a partner, and play **one real-time game (tic-tac-toe)** and **one asynchronous game (battleship)**.

The point of that definition is that it needs **no further backend work** — every server-side piece it depends on is already done and tested. What is missing is entirely the client and the shell.

Two things about the MVP are easy to get wrong and are called out where they appear below:

- **A phone cannot reach `127.0.0.1`.** Everything so far is verified against a local stack, which is fine for a simulator or a LAN dev build. Running on a real device away from the dev machine — and anything on TestFlight — needs a hosted Supabase project with the migrations pushed to it (task 21B).
- **Notification READS are MVP, not deferred.** The game functions already write `your_turn` rows, but nothing reads them. A turn-based game where you cannot tell it is your turn is not usable, so a slice of 19.1 stays in scope while push (19.2) and category settings do not.

Deferring is a real reduction in scope, not a reshuffle. Specifically: **Requirement 5.1 (identical data on mobile AND desktop) is not satisfied by an iOS-only MVP.** That is acceptable for two people testing their own app; it is not acceptable for a public release.

The game-related cron jobs (20.1) were initially deferred and then pulled back INTO the MVP, because deferring them meant abandoned real-time sessions never cleaned themselves up — a partner could be left staring at a paused game that would never resolve. Feasibility was confirmed against the local stack first (`pg_cron` is preloaded and fires at 1-second granularity), and implementing them as plain plpgsql rather than cron-invoked Edge Functions made them cheap enough to keep. See section 20 for that reasoning.

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

  - [x] 16.2 Implement Storage bucket for drawing images
    - Create a pairing-scoped private Storage bucket and wire upload/read of drawing-game images referenced by async game state
    - The bucket and its RLS policies already shipped with task 2.3; this task added the wiring: `packages/core/src/storage/drawing-images.ts` (pure object-key rules — the key layout **is** the security boundary, since Storage RLS authorizes on the first path segment) and `drawing-store.ts` (upload + signed-URL reads). `async-take-turn` now validates a drawing turn's `imageRef` against the caller's pairing/session so a foreign reference cannot be persisted into the gallery. 13 unit + 4 integration tests, mutation-checked by flattening the Storage RLS policies and by disabling the ref check.
    - _Requirements: 7.3_

  - [x] 16.3 Write asynchronous game integration tests
    - Assert a non-holder turn is rejected with state unchanged, a valid turn transfers ownership and notifies the other partner, and the terminal outcome is delivered/deferred to an offline partner
    - Passing against a live stack (7 tests), also covering Req 7.2/7.3/7.8/7.9/7.11. Writing these found that a battleship session started without ship placements could never reach a terminal state — fixed in the preceding commit. Mutation-checked by dropping and gutting the `async_take_turn` RPC (no holder transfer, no outcome, no notifications): 4 tests fail. Note `async-start` takes its options NESTED under `options`, i.e. `{ gameId, options: { ships, size, firstHolder, maxRounds } }`.
    - _Requirements: 7.5, 7.7, 7.10_

- [x] 17. Quiz wiring — **[DEFERRED, post-MVP]**
  - Cost of deferring: Requirement 8 is entirely unavailable. The pure quiz logic and its property tests (7.x) are already done, so this is wiring only. Note there is **no seed data** for `quiz_defs` / `quiz_questions` yet — whoever picks this up needs to create some before anything can be exercised end to end.

  - [x] 17.1 Implement quiz submission and scoring Edge Function
    - Handle `startSession` (partial-UNIQUE one-active-per-pairing), `submitSelfAnswer`/`submitGuess` (validation, retain prior on reject), phase transitions, and `scoreSession`; enforce `requirePairing`
    - Added the authenticated `quiz` Edge Function plus service-role-only transactional RPCs. Pairing membership, catalog/question membership, phase, duplicate submissions, and payload shape are rechecked under database locks; the partial unique index arbitrates concurrent starts. Phase gates and score increments are committed atomically, while exact answer matching stays shared with `@ldr/core`. A clean local reset, schema lint, Edge typecheck, and full two-question live smoke all pass.
    - _Requirements: 8.2, 8.3, 8.5, 8.6, 8.7, 8.8, 8.10, 8.11, 8.12, 8.13_

  - [x] 17.2 Wire the client quiz module with RLS-backed withholding
    - Implement the client `QuizModule` reading through RLS so the partner's self-answers are non-selectable during the self-answer phase and results (self-answers, guesses, scores) surface on completion
    - Added `packages/core/src/quiz/` with a caller-scoped Supabase adapter and client module. Catalog/session reads go directly through authenticated RLS while every mutation invokes the authoritative `quiz` function; completed reads assemble full `QuizResults`, and incomplete reads never synthesize absent partner answers. Seven unit tests cover catalog, mutations, rejection stability, withheld views, caching, and completed results.
    - _Requirements: 8.1, 8.4, 8.8_

  - [x] 17.3 Write quiz integration tests
    - Assert the RLS policy withholds self-answers during the self-answer phase and reveals them in the guessing/complete phase (**Property 28**), and that scoring/results are correct end to end
    - Added two live-stack tests covering the full two-question lifecycle, one-active-session rejection, response and direct-RLS withholding/reveal, rejected-duplicate state preservation, normalized scoring, completed results, and displaced-token denial. Writing the suite aligned duplicate answer/guess HTTP responses with conflict semantics (`409`).
    - _Requirements: 8.4, 8.7, 8.8_

- [x] 18. Calendar and reminder wiring — **[DEFERRED, post-MVP]**
  - Cost of deferring: Requirements 9 and 10 are entirely unavailable. The pure logic (8.x) is done, as is the Realtime groundwork — migration `20260901000002` already publishes `relationship_dates` and `reminders` and sets `REPLICA IDENTITY FULL` on both so deletes propagate, so this is the cheapest deferred section to pick up.

  - [x] 18.1 Implement date create/edit/delete writes with Postgres Changes
    - Wire pairing-scoped date create/edit/delete through RLS-guarded writes (validation re-run server-side, not-found rejection) propagating to both partners within 5s, and list dates via `orderDates`
    - Added an authenticated `calendar` Edge Function which runs the shared title/date validators and writes with the caller's bearer token, preserving the existing pairing/epoch RLS boundary. The client CalendarModule provides ordered reads, local cache, create/edit/delete, and pairing-filtered Postgres Changes with stale-read race protection. A database migration independently rejects ECMAScript-whitespace-only titles and years outside 1..9999. Fourteen unit tests and six live-stack tests pass, including modified-client constraint probes and measured partner propagation (~1.1s under the 5s budget).
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 18.2 Implement setReminder and reminder scheduling rows
    - Persist reminders with `nextTriggerAt` from `reminderTriggerTime` (reject out-of-range/non-future), cascade-delete with their date, and reschedule recurring reminders on delivery
    - Added `CalendarModule.setReminder` and an authenticated `calendar` action that calculates the next UTC occurrence with the shared helpers using the server clock. A service-role-only transaction rechecks the active pairing, session epoch, date ownership, exact derived trigger, and future/range boundaries under locks before inserting. Reminder durations now stay exact as `bigint` milliseconds end to end; existing seconds are migrated losslessly, authenticated direct mutations and the generic sync-write bypass are closed, and a composite date/pairing foreign key preserves cascade ownership. The delivery transaction marks one-off reminders delivered and advances recurring reminders—with February 29 clamping and delayed/offline-year skipping—to the first future trigger at the same lead time. Twenty-two focused unit tests, thirteen live calendar tests, a clean local migration reset, and database lint pass.
    - _Requirements: 10.1, 10.2, 10.4, 10.5_

  - [x] 18.3 Write calendar/reminder integration tests
    - Assert create/edit/delete propagate within 5s, invalid title/date/lead-time are rejected with no change, and deleting a date cascades reminder cancellation
    - Thirteen live-stack tests now cover the complete calendar/reminder boundary. The Realtime test measures create, edit, and delete independently from mutation start and asserts the partner's cached content—not merely receipt of an event—within five seconds. The suite also probes invalid title/date/lead-time requests with before/after row equality, exact trigger persistence and inclusive lead bounds, cross-pairing not-found behavior, direct-write denial, delete cascade, and recurring/one-off delivery lifecycle behavior. The targeted suite and the full 76-test local integration run pass.
    - _Requirements: 9.1, 9.4, 10.2, 10.4_

- [ ] 19. Notification wiring — **partially [MVP]**
  - 19.1 is SPLIT. The in-app read path is MVP: the pairing, game-invite and `your_turn` rows are already being written by the pairing and game Edge Functions, and nothing reads them. Out-of-app push and category settings are deferred.

  - [x] 19.1a Implement in-app notification reads and acknowledgement — **[MVP]**
    - Implemented in `packages/core/src/notifications/` as `notification-module.ts` (eligibility, ordering, acknowledgement over injected ports) and `supabase-ports.ts` (the `supabase-js` adapter). 18 unit + 7 integration tests. No Edge Function and no schema change: `notifications` is recipient-scoped by RLS with SELECT+UPDATE granted to `authenticated`, so a client reads and acknowledges its own rows directly.
    - Category filtering (Req 11.3) is included rather than deferred with 19.1b — `shouldDeliver` already existed and the settings table is already readable, so honouring a mute cost one query, whereas adding the filter later would have meant revisiting every read path. Only the settings WRITE path is deferred.
    - Wire the recipient-scoped `notifications` Realtime subscription (game invites and your-turn <5s), `acknowledge` (mark delivered + suppress re-delivery), and undelivered retrieval within the 30-day window using the existing `shouldDeliver` / `isExpired` helpers
    - `notifications` is already in the `supabase_realtime` publication (migration `20260826062557`) and is recipient-scoped by RLS, so no schema work is needed
    - _Requirements: 11.1, 11.2, 11.4, 11.6_

  - [ ] 19.1b Implement notification category settings — **[DEFERRED, post-MVP]**
    - Cost of deferring: Req 11.3 unavailable, so a user cannot mute a category. Acceptable while the only categories are game invites and your-turn.
    - _Requirements: 11.3_

  - [ ] 19.2 Implement push dispatch Edge Function — **[DEFERRED, post-MVP]**
    - Cost of deferring: notifications only appear while the app is OPEN. For an asynchronous game that means you learn it is your turn on next launch rather than being told. Tolerable for MVP, and the single highest-value post-MVP addition.
    - Dispatch best-effort out-of-app push to Expo Push (mobile) and the desktop notification API from an Edge Function, on top of the durable notifications table
    - _Requirements: 11.1, 11.2_

  - [x] 19.3 Write notification integration tests — **[MVP for the 19.1a slice]**
    - 7 tests passing. Mutation-checked by flattening both `notifications` RLS policies to `using (true)`. That first revealed the read assertion was NOT testing RLS at all — the adapter's client-side `.eq('recipient_account_id', ...)` filter masked it, the same masking that made the Property 10 concurrency test vacuous. The suite now also probes the table **unfiltered**, so RLS is the only thing standing (33 rows leaked under the mutation vs 1 expected).
    - The disabled-category assertion is in scope now; the settings write path stays with 19.1b.
    - MVP portion: assert game-invite and your-turn notifications arrive within 5s and that acknowledged notifications are not re-delivered. The disabled-category assertion waits for 19.1b.
    - _Requirements: 11.1, 11.2, 11.6_

- [ ] 20. Scheduler (pg_cron) — **20.1 is [MVP]**
  - Moved into the MVP after confirming feasibility against the local stack: `pg_cron` 1.6.4 is in `shared_preload_libraries` and fires reliably at 1-second granularity (a probe job scheduled at `1 seconds` produced 14 successful runs in 8 seconds). So there is no infrastructure risk here, and 20.1 is what stops abandoned real-time sessions accumulating.
  - **Deviation from design.md, deliberate.** The design says these are "cron jobs invoking Edge Functions". For 20.1 they are implemented as **plpgsql functions called directly by pg_cron**, with no Edge Function and no `pg_net`. All three jobs are the same shape — compare a timestamp, transition a row, insert notifications — which is exactly what `dissolve_pairing` and `app.insert_derived_notifications` already do. Reasons:
    - **Transactional:** the transition and its notifications commit together. Across an HTTP hop they cannot, so a failure mid-flight could terminate a session without notifying anyone.
    - **Deterministically testable:** each function takes `p_now` (the convention every other RPC here follows), so tests invoke it with a synthetic time instead of waiting for a real 60s / 5min / 48h window. Without this, Req 7.12's 48-hour nudge is not practically testable at all.
    - **No `pg_net` → edge-runtime hop**, which is awkward from inside the DB container locally, and no service-role secret for the cron caller.
    - The design's Edge-Function guidance still stands for any scheduled job with real logic; these three have none.
  - **Threshold drift is the one real cost** of implementing in SQL: the windows already exist as TypeScript constants (`JOIN_WINDOW_MS`, `REJOIN_WINDOW_MS` in `domain/rt-session.ts`; `TURN_NUDGE_THRESHOLD_MS` in `domain/async-lifecycle.ts`). Mitigated by 20.3 importing those constants and asserting the SQL boundary against them, so a divergence fails a test rather than going unnoticed.

  - [x] 20.1 Implement game-related cron jobs — **[MVP]**
    - Implemented in migration `20260901000003` as three plpgsql functions plus pg_cron schedules. Verified end to end: the schedules fire on their own (`ldr-rt-join-expiry` ran twice in 70s, `ldr-rt-pause-termination` once, both `succeeded` in `cron.job_run_details`). Also added `public.ldr_scheduled_jobs()` because the `cron` schema is not exposed by the Data API, so schedules were otherwise unverifiable without a database shell.
    - Three plpgsql functions, each taking `p_now` and returning what it changed, plus pg_cron schedules invoking them with `now()`:
      - 60s real-time invitation-join expiry: `pending` sessions past the join window are cancelled and the inviter notified (Req 6.9)
      - 5-min pause termination: `paused` sessions past the rejoin window become terminal with an ended-without-outcome result, both partners notified (Req 6.10)
      - 48h async turn nudge: notify the Active_Turn_Holder WITHOUT forfeiting or terminating the session, deduped so it fires once per pending turn (Req 7.12)
    - Reuse `app.insert_derived_notifications` so notification dedupe behaves identically to the turn path (Req 11.6)
    - _Requirements: 6.9, 6.10, 7.12_

  - [ ] 20.2 Implement reminder, inactivity, and retention cron jobs — **[DEFERRED, post-MVP]**
    - Cost of deferring: reminders never deliver (Req 10.3), sessions never expire from 30-day inactivity (2.6), and notifications are never discarded at 30 days (11.5). The first is moot while 18.x is deferred; the other two only matter over a long-lived deployment.
    - Create pg_cron jobs for reminder delivery within 60s of trigger (defer offline), 30-day session inactivity revocation, and 30-day notification retention/discard
    - _Requirements: 2.6, 10.3, 11.4, 11.5_

  - [x] 20.3 Write scheduler integration tests — **[MVP for the 20.1 jobs]**
    - 7 tests passing. Mutation-checked three ways: changing `48 hours` to `48 minutes` and `60 seconds` to `60 minutes` fails the bracketed tests (so unit mix-ups are caught), and adding a `state = 'terminal'` update to the nudge fails the Req 7.12 test (so a forfeit regression is caught). The 20.2 windows wait for 20.2.
    - Call each function directly with a synthetic `p_now`, BRACKETING the window: at `threshold - 1s` nothing transitions, at `threshold + 1s` it does. Bracketing is what makes the test about the specific window rather than "any elapsed time triggers it".
    - Import the TS threshold constants and assert the SQL agrees with them, so drift between the two fails here.
    - Separately assert the pg_cron schedules exist and are enabled (`cron.job`), since a correct function that is never scheduled is still a broken feature.
    - Assert the 48h nudge does NOT terminate or forfeit the session (Req 7.12) and does not duplicate on repeated runs (Req 11.6).
    - The 20.2 windows (reminder delivery, 30-day inactivity/retention) wait for 20.2.
    - _Requirements: 6.9, 6.10, 7.12_

- [ ] 21. Client service modules and Connection Manager — **[MVP]**
  - [x] 21.1 Wire AuthenticationModule and PairingModule — **[MVP]**
    - Implemented in `packages/core/src/auth/` as `auth-module.ts`, `pairing-module.ts` and `supabase-ports.ts` (the `supabase-js` adapter). 26 unit tests. Ports are injected as in `sync/` and `notifications/`, so 21.3 can compose these rather than reaching through a client it does not own.
    - Neither module re-derives a server rule. `authenticate` runs NO local credential validation — Req 2.2 demands a uniform failure, and rejecting a malformed email client-side would reveal what the server refuses to. `PairingModule` performs no exclusivity check, deliberately: a client-side pre-check is what MASKED the database guard in the Property 10 concurrency test (see 13.3), so exclusivity is left entirely to the partial UNIQUE indexes.
    - `currentSession` evaluates the local session against `account_session` with the shared `evaluateSession`, yielding `SESSION_SUPERSEDED` (Req 2.9) or `SESSION_EXPIRED` (Req 2.6). This depends on `account_session_select_self` being `account_id = auth.uid()` with NO epoch guard — verified against the live database — which is what lets a displaced client read the newer epoch and route itself to sign-in.
    - Two deviations. `acceptInvitation(code)` drops design.md's `now` parameter: the 72h window is evaluated inside the acceptance transaction against the database clock, so a client-supplied time would either be ignored or be a way to accept an expired invitation. And the adapter unwraps the error body by hand from `FunctionsHttpError.context`, because `functions.invoke` discards the parsed body and would otherwise make `ALREADY_PAIRED` indistinguishable from a network failure.
    - Session persistence is an injected `SessionStore` port, not implemented here — Expo SecureStore is task 22.1b's to provide.
    - Every endpoint these wrap is already integration-tested, so the verified contracts are in `packages/core/src/__harness__/auth.integration.test.ts` and `pairing.integration.test.ts` — read those for the exact request/response shapes rather than inferring them
    - _Requirements: 2.1, 2.4, 2.5, 3.1, 3.2, 4.1_

  - [x] 21.2 Wire the game and notification client modules with Local Store — **[MVP, trimmed]**
    - MVP scope: `RealTimeGameModule` (tic-tac-toe), `AsyncGameModule` (battleship), and the read-side `NotificationModule` from 19.1a, each over the Local Store cache for instant/offline reads
    - `CalendarModule` and `QuizModule` are deferred with sections 17/18. The drawing game is deferred too, though only its UI: its Edge Function path and Storage wiring are already done and integration-tested (16.1, 16.2), so adding it later is a UI-only increment
    - The Local Store is introduced here — task 14.2 deliberately left it out, handing remote changes to an `onRemoteChange` listener instead of caching them, so this task owns the cache design
    - Implemented as `packages/core/src/store/local-store.ts`, `packages/core/src/games/{rt-game-module,async-game-module,supabase-ports}.ts`, and an optional `LocalStore` on `createNotificationModule`. 61 new unit tests (18 store, 17 real-time, 17 async, 9 notification).
    - **Writes are versioned.** `put` takes an optional monotonic `version` and ignores a lower one. This is not speculative: a `takeTurn` response and the Postgres Changes replay of the same commit race, so an older commit's replay can land after a newer response and visibly rewind the board. The async module versions by recorded turn count (Req 7.5 appends exactly one per valid turn); notifications version by acknowledgement time, which stops a `fetchAll` issued before a dismissal but answered after it from resurrecting the row (Req 11.6).
    - **No local pre-validation of moves.** Running the shared pure `applyMove` before calling `rt-move` looks like free latency, but the cache lags the authoritative row by design, so a move the server WOULD accept — the partner has already played and it really is our turn — gets refused against stale state. Legality is the server's alone; the pure engine stays available for optimistic *rendering*, which is a different thing.
    - **Two async mappers, one real-time.** An async session arrives either as the function's camelCase payload or as the raw replicated snake_case row (async rides Postgres Changes, not Broadcast, so it survives absence per Req 7.11). Sharing one mapper would silently drop `active_turn_holder`. Real-time needs only the payload mapper because its fast path is Broadcast.
    - Rejections are handled asymmetrically because the contracts are: `rt-move` echoes the unchanged state in `error.details.gameState`, so the module resynchronises a drifted board from it (Req 6.11); `async-take-turn` echoes nothing, so the cache is left strictly alone (Req 7.7, 7.8).
    - No channels are opened here. `applyRemoteState` / `applyRemoteRow` are the entry points **task 21.3** feeds, mirroring how 14.2 left remote changes to an injected listener. `rt-presence` is deliberately unwired: producing its snapshot means tracking a Presence channel, which is 21.3's.
    - Persistence is `snapshot`/`hydrate` only — core is platform-neutral and cannot reach SecureStore or disk, so 22.1b owns the actual storage.
    - Refactor: `readErrorEnvelope`/`narrowCode` moved from `auth/supabase-ports.ts` to `supabase/function-error.ts`, since a second copy of the `FunctionsHttpError.context` unwrapping is a second chance to get it subtly wrong.
    - Verified contracts are in `packages/core/src/__harness__/realtime-game.integration.test.ts` and `async-game.integration.test.ts` — read those for exact request/response shapes rather than inferring them
    - _Requirements: 5.1, 6.1, 7.1_

  - [x] 21.3 Implement Connection Manager channels, reconnect, and displacement sign-out — **[MVP]**
    - Maintain Realtime subscriptions (Postgres Changes, Broadcast, Presence), handle reconnect and queue drain, and force local sign-out when the per-account revoke signal arrives
    - **Compose** the task 14.2 modules rather than rewriting them: `createSyncModule` / `createSupabaseSyncPorts` already own the pairing-scoped Postgres Changes subscription, the connectivity state machine, and the reconnect queue drain, with injected ports specifically so this task can wrap them. What is genuinely new here is Broadcast, Presence, and the revoke-driven sign-out
    - The client-side Presence tracking that produces the snapshot for `rt-presence` belongs here (deferred from 15.2), and it is what makes Req 6.6 work end to end
    - Implemented in `packages/core/src/connection/` as `presence.ts` (pure roster + report scheduling), `connection-manager.ts` (routing and lifecycle) and `supabase-ports.ts` (the channel adapter). 41 unit tests. The sync module is CONSTRUCTED here from `SyncPorts` rather than passed in: its listeners are fixed at construction, so accepting a pre-built instance would need the manager to exist first. It is re-exposed as `manager.sync` so a shell still reaches `applyChange` and the queue.
    - **A revoke is obeyed only on a STRICTLY newer epoch.** `auth-login` broadcasts the revoke with the epoch it just minted — the one the winning client now holds — so a `>=` comparison would make every successful sign-in immediately sign itself back out. A malformed signal is dropped rather than guessed at, since the epoch guard rejects the stale token on its next request anyway (Req 2.8) and is the real authority.
    - **Presence preserves the absence start.** Realtime re-emits `sync` frequently; refreshing `lastSeenAt` on each frame would restart the 30-second window every few seconds so a session could never pause. Reports are scheduled to wake once when the pause becomes due rather than polling across the window, then repeat on a 10s interval because the first report can lose a race with a concurrent move or an in-flight rejoin. A client never reports its own absence — that would ask the server to pause the game on the reporter.
    - `DISCONNECT_THRESHOLD_MS` in core MIRRORS the server's in `_shared/rt-presence.ts` but does not decide anything: it only schedules when to ask, so a drift costs an early or late report, never a wrong pause.
    - Writing this found two defects in 21.2's caching. `rt-rejoin` and `rt-presence` serialize sessions with their own narrower `sessionView` that OMITS `pairingId`, so caching by replacement blanked it on every rejoin; and the `paused`/`resumed`/`outcome` broadcasts carry `{ sessionId, gameState }` with no `state` field at all, so they could not be applied as sessions. The cache now merges over what is known, and `applyRemoteEvent` resolves the event name to the transition. An event for an uncached session is skipped rather than half-built, since these payloads carry no `gameId` or `pairingId`.
    - Timers are injected (`schedule`), so the presence schedule is asserted through a fake clock instead of a sleeping test. A report in flight when `leaveGame` runs does not re-arm.
    - `rt-presence` is now wired end to end (it was deliberately left out of 21.2). Postgres Changes routing is limited to `async_sessions`: real-time state rides Broadcast for Req 6.4's 2s budget, and notifications have their own recipient-scoped subscription
    - _Requirements: 2.9, 5.3, 5.4, 6.6_

- [ ] 21B. Hosted Supabase project — **[MVP, required for on-device]**
  - Everything so far is verified against a LOCAL stack. A phone cannot reach `127.0.0.1`: a simulator or a LAN dev build can use the local stack, but running on a real device away from the dev machine, and anything on TestFlight, needs a hosted project.
  - **This is the first task that touches something not freely resettable.** Local work can be thrown away with `supabase db reset`; a hosted project cannot. Get explicit confirmation before pushing migrations to it.

  - [x] 21B.1 Create and link the hosted project, push migrations and functions
    - Create the Supabase project, `supabase link`, push all migrations, deploy the Edge Functions, and configure the auth settings the local `config.toml` sets
    - Verify by pointing the integration suite at the hosted project (the harness already reads `SUPABASE_URL` / keys from the environment, so this needs no test changes) and confirming the same 40 tests pass
    - Record the anon key and project URL as build-time config for the shells; the service-role key must NEVER ship in a client bundle
    - Hosted project `xbtnbrzwnarbqrqsxdch` is configured with `app.custom_access_token`; hosted smoke verification confirmed epoch claims in JWTs, and the hosted integration suite passed 57/57 tests. The integration harness now leaves a larger pre-threshold margin for the presence-pause test so hosted Edge Function latency cannot cross the 30s server-side threshold before evaluation.
    - _Requirements: 5.1_

- [ ] 21A. Account deletion (App Store Guideline 5.1.1(v)) — **[required to SUBMIT, not to USE]**
  - Required before iOS submission: an app that supports account creation must offer in-app account deletion. Requirement 4 (unlinking) deliberately RETAINS individual data, so it does not satisfy this. Placed here so the backend exists before the shells add the UI in 22.1/22.2.
  - Sequencing note: this blocks App Store submission but not a working dev build, so it can follow 22.1 if the priority is getting the app into your hands first. It must not be dropped, only ordered.

  - [x] 21A.1 Implement the deleteAccount pure logic
    - Implement the pure decision for account deletion: require an explicit confirmation, derive the dissolve-first-then-delete ordering, and derive the remaining partner's resulting unpaired state by reusing `dissolvePairing`; an unconfirmed request yields no change
    - Implemented `deleteAccount` in the shared domain layer. Unconfirmed requests return an explicit no-op decision; confirmed unpaired deletions plan session termination, account-row deletion, and Auth-user deletion; confirmed paired deletions call `dissolvePairing` first, expose the remaining partner's unpaired state, and then plan pairing-owned data removal plus account removal. Focused unit tests cover these cases and invalid pairing context.
    - _Requirements: 12.2, 12.3, 12.8_

  - [x] 21A.2 Write property tests for account deletion
    - **Property 43: Account deletion leaves the remaining partner consistent**
    - **Property 44: An unconfirmed deletion changes nothing**
    - **Validates: Requirements 12.3, 12.8** (exercise both unpaired and paired accounts)
    - Added property coverage proving confirmed deletion of either member of any active pairing produces the same remaining-partner state as ordinary unlink and fixes dissolve-before-delete ordering. Added unconfirmed-delete coverage across unpaired and paired inputs, asserting byte-identical input state and an empty no-op decision.

  - [x] 21A.3 Implement the delete-account Edge Function and Storage cleanup
    - Dissolve any active pairing first (reusing `dissolve_pairing` so the remaining partner gets the full Req 4 treatment), then delete the `accounts` row and the `auth.users` credential so the email is released; bump and clear `account_session` so already-issued tokens fail the epoch guard; explicitly remove the pairing's prefix from the `drawings` Storage bucket, which does NOT cascade from a Postgres delete; complete within 30s
    - Implemented `delete-account` plus the service-role-only `delete_account_data` RPC. The RPC serializes on the account, calls `dissolve_pairing`, deletes the pairing so every pairing-owned row cascades, advances/removes the session registry, and deletes the application account in one Postgres transaction. The function recursively removes the pairing's `drawings` prefix and deletes the Auth user last, releasing the email.
    - Since Postgres, Storage, and Auth cannot share one transaction, the RPC atomically writes a retry marker plus every current/historical pairing prefix into Auth app metadata before deleting application rows. If external cleanup fails, the same confirmed request resumes Storage/Auth cleanup instead of orphaning images or the credential. A displaced token is rejected both at the Edge boundary and again inside the locked database transaction; `verify_jwt` alone checks signature/expiry, not the app's single-session invariant.
    - Verified by applying the migration locally, `supabase db lint --local` (no schema errors), Deno type/format checks, and a local Edge smoke run proving an unconfirmed request is a no-op while a confirmed unpaired deletion removes both the application row and Auth user.
    - _Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [x] 21A.4 Write account-deletion integration tests
    - Assert no row anywhere references the deleted account and the email can register again (**Property 42**), the remaining partner is left consistent and notified (**Property 43**), tokens for the deleted account are refused (12.5), pairing-owned rows AND Storage objects are gone (12.6), and an unconfirmed request changes nothing (**Property 44**)
    - Added 4 live-stack tests covering unpaired deletion plus same-email re-registration, paired deletion within the 30-second budget, surviving-partner state/notification, account- and pairing-owned SQL cascades, current and historical pairing Storage-prefix removal, post-delete and displaced-token rejection, and the byte-identical unconfirmed no-op. The strengthened historical-pairing case pins the requirement that content from ANY pairing the account belonged to is erased, not only its current pairing.
    - _Requirements: 12.4, 12.5, 12.6, 12.8_

- [ ] 22. Platform shells
  - [x] 22.1a Scaffold the Expo app — **[MVP]**
    - `apps/mobile` was a STUB: no `expo`, `react` or `react-native` dependency, and `main` pointed at a `src/main.ts` that only returned theme tokens. It is now a real Expo app on SDK 57 (React 19.2.3, React Native 0.86.3), with `src/index.ts` registering the root component, `src/App.tsx` holding a React Navigation native-stack, `src/theme.ts` bridging core tokens onto React Navigation's `Theme`, and `src/screens/BootScreen.tsx` as a placeholder that renders values read from `@ldr/core`.
    - **Verified beyond the acceptance criterion.** The task asked for the iOS simulator; it was instead built, signed and run on a physical iPhone 17 Pro (iOS 27) — 1013 modules bundled, no runtime errors. The boot screen deliberately renders `@ldr/core` values, so a successful launch is evidence the shared package resolves and themes correctly through Metro, which was the actual risk in this scaffold.
    - `ios.bundleIdentifier` is `com.ldrcompanion.app`; `supportsTablet` is false to match the iPhone-only MVP. `android.package` is set despite Android being out of scope, because changing an application id after the first build is disruptive and costs nothing now.
    - **Three monorepo-specific Metro settings, all required.** `watchFolders` reaches the repo root (Metro will not follow a symlink out of `projectRoot`), `nodeModulesPaths` lists the app's and the root's `node_modules` (npm hoists most dependencies), and `unstable_enablePackageExports` lets Metro honour `@ldr/core`'s ESM `exports` map. The fourth, `disableHierarchicalLookup`, is the one that is easy to delete and expensive to lose — see `decisions.md`.
    - Relative imports inside `apps/mobile` are **extensionless**, unlike `packages/core`'s NodeNext `.js` specifiers: Metro resolves literally and will not map `./App.js` onto `App.tsx`. The two conventions coexist deliberately.
    - `expo-system-ui` was added because `prebuild` only *warns* when it is missing and silently drops `app.json`'s `backgroundColor`, leaving a white native window behind the pastel UI.
    - Native `ios/` is generated by `prebuild` and gitignored — it is a build artifact, and committing it would fork the config so an `app.json` edit would stop matching the checked-in Xcode project.
    - Device builds use the free personal team `9579GM6TA2`, whose provisioning profile expires every 7 days; the app then needs a rebuild, not a re-setup. Signing and Metro-staleness pitfalls that cost real time here are recorded in `decisions.md`.
    - Still deferred to 22.1b as planned: SecureStore session persistence, cache hydration from disk, and every real screen. Nothing here talks to Supabase yet, which is why it runs without the hosted project (`21B.1`).
    - _Requirements: 5.1_

  - [x] 22.1b Build the MVP mobile screens — **[MVP]**
    - Screens: sign in / register, pairing (create + accept an invitation), a game list, a tic-tac-toe board, and a battleship board, over `AuthenticationModule`, `PairingModule`, `RealTimeGameModule`, and `AsyncGameModule` from 21.1/21.2.
    - Expo SecureStore holds the domain `Session` and the supabase **refresh token** (peeled out of the supabase-js session blob; access token + user stay in AsyncStorage). Local Store snapshots hydrate from AsyncStorage so a cold start can render cached games (Req 5.1).
    - Identity gate: no session → sign in (Req 2.5); signed in but unpaired → pairing; active pairing → game list + boards. All colours come from `@ldr/core` tokens via the 22.1a navigation bridge; no component hex.
    - Game list is tic-tac-toe + battleship only (drawing is filtered out). Battleship start auto-places a classic fleet for both partners because `async-start` has no placement endpoint and a zero-cell fleet can never end (Req 7.10). Join-by-session-id is a temporary bridge until 23.1 delivers invites live.
    - Connection Manager, sync, and notification reads are **not** wired — that is 23.1. 16 unit tests cover the gate, codecs, storage split, error copy, and board helpers.
    - Verified: typecheck, lint, unit tests, simulator launch (1090 modules, no runtime errors) against the local stack. `register` returns 201 on `127.0.0.1:54321`.
    - _Requirements: 5.1, 6.1, 7.1_

  - [ ] 22.1c iOS release prerequisites — **[required to SUBMIT]**
    - A 1024x1024 app icon and a splash image (`app.json` currently sets only `backgroundColor`)
    - `eas.json` with build profiles, and an EAS build that installs on a real device
    - APNs key, once 19.2 (push) lands
    - The two-step account-deletion confirmation UI from 21A (Req 12.1, 12.2)
    - A privacy policy URL and the App Privacy disclosures — this app handles email, relationship dates and user-drawn images, so the questionnaire is non-trivial
    - A demo account **pair** for App Review: reviewers cannot test a two-person pairing feature with a single login, which is a common rejection cause for partner apps
    - _Requirements: 11.1, 12.1, 12.2_

  - [ ] 22.2 Build the Electron/web desktop shell — **[DEFERRED, post-MVP]**
    - Cost of deferring, stated plainly: **Requirement 5.1 is not satisfied by an iOS-only MVP.** 5.1 requires the same account and shared data to be presented on mobile AND desktop. Deferring this is a genuine reduction in scope, not a reordering, and it should be restored before any claim that Requirement 5 is met.
    - Implement desktop UI over the shared modules, Electron `safeStorage`/OS keychain for the refresh token, and desktop notification integration, plus the same two-step account-deletion confirmation as mobile (Req 12.1, 12.2)
    - _Requirements: 5.1, 11.1, 12.1, 12.2_

  - [ ] 22.3 Write cross-platform parity tests — **[DEFERRED with 22.2]**
    - Blocked by 22.2: parity cannot be asserted against one shell.
    - Load identical account/shared state through the mobile and desktop shells and assert presentation equality
    - _Requirements: 5.1_

- [ ] 23. Final integration and end-to-end wiring
  - [x] 23.1 Wire the MVP modules into the mobile shell end to end — **[MVP, trimmed]**
    - MVP scope: auth, pairing, sync, the real-time game, the asynchronous game, and notification reads wired into the mobile shell with no orphaned code; verify the game list presents to both partners
    - Quizzes, calendar and reminders join this task when 17/18 are picked up; the desktop half joins with 22.2
    - Implemented in the mobile runtime and paired stack: the Connection Manager now opens account/pairing channels after pairing, subscribes to notification reads, refreshes async sessions, routes async Postgres Changes into the Local Store, and joins real-time game channels when a tic-tac-toe board is opened. The game list no longer needs manual session ids; it surfaces game-invite notifications and lets the invited partner join/open from the linked account.
    - Also fixed MVP launch blockers found during the end-to-end pass: invitation codes are now short 8-character uppercase codes with case-insensitive acceptance; both real-time and async starts reject a fourth open session of the same game type; Battleship boards use fixed 44pt cells with horizontal scrolling and visible hit/miss/ship markers; the shared screen wrapper respects the top safe area on Dynamic Island simulators.
    - Verified: `npm run typecheck`, `npm run lint`, `npm run test:unit` (349 tests), `npm run test:property` (73 tests), `npm run edge:check`, `npm run edge:test` (22 tests), `npm --workspace @ldr/mobile run bundle:check`, `npm run test:integration:local` (57 tests), plus Xcode simulator build/install/launch on iPhone 17 Pro and iPhone 17 Pro Max.
    - _Requirements: 5.1, 6.1, 7.1_

  - [ ] 23.2 Write security and privacy tests
    - Assert self-answers never appear in a partner's response during the self-answer phase, a former partner cannot read pairing-owned data after dissolution, and error/RLS responses contain no sensitive data or existence leaks
    - _Requirements: 4.4, 8.4, 1.6_

- [ ] 24. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks are marked `[MVP]` (on the path to a usable iOS app) or `[DEFERRED, post-MVP]` (with the cost of deferring stated on the section). Deferred does not mean dropped — see the MVP Scope section for what each deferral actually costs.
- Each task references specific granular requirements for traceability; every one of the 12 requirements and all 44 correctness properties is covered by the FULL plan. The MVP subset deliberately does not cover Requirements 8, 9, 10, parts of 11, and the desktop half of 5.1.
- Pure domain helpers and their `fast-check` property tests (min 100 iterations, tagged `// Feature: ldr-companion-app, Property {n}: {text}`) are implemented before the Supabase wiring so logic is verified before integration.
- Properties additionally enforced by RLS/constraints (8, 10, 14, 28) are re-verified at the integration layer; timing/latency criteria (5.3, 6.4, 10.3, 11.1, 11.2) are covered by integration tests, not properties.
- Checkpoints ensure incremental validation at natural breaks.
- Section 21A and Requirement 12 (Account Deletion) were added after the original plan. Requirement 12 brings the total to **12 requirements** and Properties 42–44 bring the total to **44 correctness properties**. It is not optional: without in-app account deletion the app cannot pass Apple App Store review (Guideline 5.1.1(v)), and unlinking does not substitute for it because Req 4.4 explicitly retains individual data.

## Observed Post-MVP Backlog

These are accepted as out of scope for the current MVP, but should be preserved for the next pass instead of rediscovered:

- Games need explicit removal/cancel controls. Users currently cannot cancel pending games or remove stale/finished games from the visible list.
- Terminal game sessions are recorded correctly but remain visible indefinitely. Decide whether completed sessions should be hidden by default, archived, or moved into history before changing the session lifecycle.
- Battleship is playable and syncs, but the rules need a product pass; the current MVP auto-placement and turn loop are intentionally minimal.
- Game icons are placeholder-quality and should be replaced with theme-consistent, recognizable icons.
- The theme architecture already supports multiple named color options, but the mobile shell has no theme changer/settings UI yet.
- Add a wins screen showing each partner's win count across games.
- Longer-term navigation may split the app into category screens, for example Games, leaderboards/history, relationship tools, settings, and future quiz/calendar areas.

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
    { "id": 7, "tasks": ["14.3", "17.3", "21.1", "21.2", "21.3", "21A.1"] },
    { "id": 8, "tasks": ["21A.2", "21A.3"] },
    { "id": 9, "tasks": ["21A.4", "22.1", "22.2", "23.1"] },
    { "id": 10, "tasks": ["22.3", "23.2"] }
  ]
}
```

Account deletion (21A) depends on the pairing dissolution transaction (13.2) and the Storage wiring (16.2), both complete, so `21A.1` could be pulled earlier if iOS submission needs to move up. It is scheduled before the shells because 22.1/22.2 own the confirmation UI.

### MVP Critical Path

The graph above is the full plan. The MVP path through it is a strict sequence, because each step is the input to the next:

```json
{
  "mvpPath": [
    { "step": 1, "task": "19.1a", "why": "notification reads; games already write the rows and nothing reads them" },
    { "step": 2, "task": "21.1",  "why": "auth + pairing client over already-tested endpoints" },
    { "step": 3, "task": "21.2",  "why": "real-time + async game modules and the Local Store" },
    { "step": 4, "task": "21.3",  "why": "Broadcast, Presence and revoke sign-out, composing the 14.2 modules" },
    { "step": 5, "task": "22.1a", "why": "turn the apps/mobile stub into a real Expo app" },
    { "step": 6, "task": "22.1b", "why": "the MVP screens" },
    { "step": 7, "task": "23.1",  "why": "wire it together and play a real game partner-to-partner" },
    { "step": 8, "task": "21B.1", "why": "hosted project, so it runs on a phone off the dev machine" }
  ],
  "mvpBackendPrerequisite": [
    { "task": "20.1", "why": "abandoned real-time sessions must clean themselves up; plain plpgsql, no Edge Function" },
    { "task": "20.3", "why": "brackets each window and pins the SQL thresholds against the TS constants" }
  ],
  "thenToSubmit": ["21A.1", "21A.2", "21A.3", "21A.4", "22.1c"],
  "deferred": ["17.x", "18.x", "19.1b", "19.2", "20.2", "22.2", "22.3"]
}
```

`20.1` / `20.3` are backend work with no client dependency, so they can be done before step 1 or in parallel with the client tasks — they are listed separately rather than in the sequence for that reason.

`21B.1` is placed last on the MVP path deliberately: everything before it can be built and exercised against the local stack, so the hosted project is only needed at the point you want the app on a phone. It is also the first irreversible step, so it should not be taken earlier than necessary.
