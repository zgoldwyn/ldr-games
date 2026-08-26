/**
 * Pure, deterministic state transitions for a real-time game session
 * (Requirements 6.3, 6.6, 6.7, 6.8).
 *
 * A real-time session moves through the lifecycle
 * `pending -> active -> terminal`, with `active <-> paused` while a partner is
 * briefly disconnected:
 *
 * - **Join (Req 6.3):** an invited session is `pending`. Once both partners have
 *   joined *within 60 seconds* of the invitation it becomes `active` and both
 *   sides start from one identical initial game state. If the 60s window has
 *   elapsed the join is rejected as expired.
 * - **Pause (Req 6.6):** a partner disconnect pauses an `active` session and
 *   **preserves** the current game state untouched.
 * - **Rejoin (Req 6.7):** rejoining *within 5 minutes* of the pause resumes the
 *   session from the preserved state, so both partners again see identical
 *   state. (Terminating a session that is *not* rejoined in time is the cron
 *   job's job — task 20.1 — not this module.)
 * - **Terminal (Req 6.8):** reaching a terminal state records an {@link GameOutcome}.
 *
 * These functions are the transitions *only*: move validation lives in the pure
 * `applyMove` engine (task 5.1), and Presence/Broadcast wiring and the timeout
 * cron jobs live in the real-time wiring tasks (15.x / 20.x). Every function
 * takes `now`/timestamps as explicit arguments and reads no clock or storage, so
 * they are fully deterministic and property-testable.
 */
import { ERROR_CODES, type RTError } from '../errors.js';
import { type Result, err, ok } from '../result.js';
import type { AccountId, Timestamp } from './common.js';
import type { GameOutcome, GameState, RTSession } from './game.js';

/** The window within which both partners must join a pending session (60s, Req 6.9). */
export const JOIN_WINDOW_MS = 60 * 1000;

/** The window within which a paused session may be rejoined/resumed (5 min, Req 6.10). */
export const REJOIN_WINDOW_MS = 5 * 60 * 1000;

/** The two accounts that make up the pairing playing a session. */
export interface RTPairingMembers {
  readonly a: AccountId;
  readonly b: AccountId;
}

/**
 * Whether a pending session is still inside its 60-second join window: true iff
 * the delta between `now` and the invitation time is at most 60 seconds
 * (Req 6.3, 6.9).
 */
export function isWithinJoinWindow(pendingSince: Timestamp, now: Timestamp): boolean {
  return now - pendingSince <= JOIN_WINDOW_MS;
}

/**
 * Whether a paused session is still inside its 5-minute rejoin window: true iff
 * the delta between `now` and the pause time is at most 5 minutes (Req 6.7, 6.10).
 */
export function isWithinRejoinWindow(pausedSince: Timestamp, now: Timestamp): boolean {
  return now - pausedSince <= REJOIN_WINDOW_MS;
}

/**
 * Whether both pairing members are present in `present`. Activation requires
 * both partners to have joined (Req 6.3); the order of `present` is irrelevant.
 */
export function bothPartnersPresent(
  present: readonly AccountId[],
  members: RTPairingMembers,
): boolean {
  return present.includes(members.a) && present.includes(members.b);
}

/**
 * Attempt the join transition on a `pending` session (Req 6.3).
 *
 * - Rejected with `INVALID_SESSION_STATE` if the session is not `pending`.
 * - Rejected with `JOIN_WINDOW_EXPIRED` if the 60-second window has elapsed.
 * - If both partners are present, transitions to `active`, seeds both sides with
 *   the single `initialState` (identical by construction — there is one
 *   authoritative session), and clears the join deadline.
 * - If only one partner has joined so far, the session remains `pending`
 *   unchanged (a success, not an error) so the other partner can still join.
 */
export function joinSession(
  session: RTSession,
  present: readonly AccountId[],
  members: RTPairingMembers,
  initialState: GameState,
  now: Timestamp,
): Result<RTSession, RTError> {
  if (session.state !== 'pending') {
    return err({
      code: ERROR_CODES.INVALID_SESSION_STATE,
      message: `Cannot join a session in state "${session.state}"; it is not pending.`,
    });
  }
  if (session.pendingSince === undefined || !isWithinJoinWindow(session.pendingSince, now)) {
    return err({
      code: ERROR_CODES.JOIN_WINDOW_EXPIRED,
      message: 'The 60-second join window for this session has expired.',
    });
  }
  if (!bothPartnersPresent(present, members)) {
    // Only one partner has joined; stay pending and wait for the other.
    return ok(session);
  }
  const { pendingSince: _pendingSince, ...rest } = session;
  return ok({
    ...rest,
    state: 'active',
    gameState: initialState,
  });
}

/**
 * Pause an `active` session on a partner disconnect, preserving the current game
 * state untouched and recording the pause time that drives the 5-minute resume
 * window (Req 6.6).
 *
 * Rejected with `INVALID_SESSION_STATE` if the session is not `active`.
 */
export function pauseSession(session: RTSession, now: Timestamp): Result<RTSession, RTError> {
  if (session.state !== 'active') {
    return err({
      code: ERROR_CODES.INVALID_SESSION_STATE,
      message: `Cannot pause a session in state "${session.state}"; it is not active.`,
    });
  }
  return ok({
    ...session,
    state: 'paused',
    // gameState is carried over unchanged: the state is preserved across the pause.
    pausedSince: now,
  });
}

/**
 * Resume a `paused` session when the disconnected partner rejoins within 5
 * minutes, restoring the preserved game state so both partners again see
 * identical state (Req 6.7).
 *
 * - Rejected with `INVALID_SESSION_STATE` if the session is not `paused`.
 * - Rejected with `REJOIN_WINDOW_EXPIRED` if more than 5 minutes have elapsed
 *   since the pause (the terminate-on-timeout transition is task 20.1, not here).
 */
export function resumeSession(session: RTSession, now: Timestamp): Result<RTSession, RTError> {
  if (session.state !== 'paused') {
    return err({
      code: ERROR_CODES.INVALID_SESSION_STATE,
      message: `Cannot resume a session in state "${session.state}"; it is not paused.`,
    });
  }
  if (session.pausedSince === undefined || !isWithinRejoinWindow(session.pausedSince, now)) {
    return err({
      code: ERROR_CODES.REJOIN_WINDOW_EXPIRED,
      message: 'The 5-minute rejoin window for this paused session has expired.',
    });
  }
  const { pausedSince: _pausedSince, ...rest } = session;
  return ok({
    ...rest,
    state: 'active',
    // gameState is unchanged from the pause: the preserved state is restored.
  });
}

/** Build a `completed` outcome for a normal terminal result (Req 6.8). */
export function completedOutcome(winner: AccountId | null, recordedAt: Timestamp): GameOutcome {
  return { kind: 'completed', winner, recordedAt };
}

/**
 * Build an `ended_without_outcome` result for a session that terminated early
 * (for example the rejoin window elapsed, Req 6.10). There is no winner.
 */
export function endedWithoutOutcome(recordedAt: Timestamp): GameOutcome {
  return { kind: 'ended_without_outcome', winner: null, recordedAt };
}

/**
 * Terminate a session, recording the given {@link GameOutcome} so the result can
 * be presented to both partners (Req 6.8). The final game state is preserved.
 *
 * Rejected with `INVALID_SESSION_STATE` if the session is already `terminal`.
 * A session may terminate from any live state (`pending`, `active`, or `paused`).
 */
export function terminateSession(
  session: RTSession,
  outcome: GameOutcome,
): Result<RTSession, RTError> {
  if (session.state === 'terminal') {
    return err({
      code: ERROR_CODES.INVALID_SESSION_STATE,
      message: 'Session is already terminal.',
    });
  }
  const { pendingSince: _pendingSince, pausedSince: _pausedSince, ...rest } = session;
  return ok({
    ...rest,
    state: 'terminal',
    outcome,
  });
}
