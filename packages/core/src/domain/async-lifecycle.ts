/**
 * Pure, deterministic lifecycle derivations for asynchronous turn-based game
 * sessions (Requirements 7.6, 7.11, 7.12).
 *
 * None of these functions read a clock, mutate state, or perform I/O: every
 * time-dependent input (`now`, `turnPendingSince`) is passed in explicitly, so
 * the results are fully reproducible and property-testable (Property 25 →
 * task 6.4, Property 41 → task 6.5). They cover three concerns:
 *
 * 1. **Persistence / inactivity (Req 7.11).** An async session that has not
 *    reached a terminal state and whose pairing has not been dissolved stays
 *    active regardless of how long the partners have been inactive. Only a
 *    terminal state or pairing dissolution ends it — elapsed inactivity never
 *    does.
 * 2. **48-hour nudge (Req 7.12).** When a turn has been pending for the
 *    Active_Turn_Holder for at least 48 continuous hours, a reminder
 *    notification is derived for the holder. Deriving a nudge is a pure
 *    read-only operation: it never forfeits or terminates the session.
 * 3. **Turn hand-off (Req 7.6).** When a valid turn completes and ownership
 *    transfers, a "your turn" notification is derived for the partner who has
 *    become the new Active_Turn_Holder.
 *
 * The turn engine itself (`applyTurn`, task 6.1) lives elsewhere; this module
 * only consumes its result shapes.
 */
import type { NotificationId, Timestamp } from './common.js';
import type { AsyncSession } from './game.js';
import type { Notification, NotificationCategory } from './notification.js';
import type { Pairing } from './pairing.js';

/**
 * Continuous time a turn may remain pending for the Active_Turn_Holder before a
 * reminder nudge becomes due (48 hours, Requirement 7.12).
 */
export const TURN_NUDGE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/** Category used for both hand-off and nudge turn notifications. */
const ASYNC_TURN_CATEGORY: NotificationCategory = 'async_turn';

/** Distinguishes the two kinds of async-turn notification in the payload. */
export type AsyncTurnNotificationKind =
  /** It is now the recipient's turn because their partner just moved (Req 7.6). */
  | 'your_turn'
  /** Reminder that a still-pending turn is waiting on the recipient (Req 7.12). */
  | 'turn_reminder';

/**
 * Structured payload carried by an async-turn {@link Notification}. `pendingSince`
 * pins the notification to a specific pending turn so re-derivation of the same
 * turn produces a stable `dedupeKey` (Requirement 11.6).
 */
export interface AsyncTurnNotificationPayload {
  readonly kind: AsyncTurnNotificationKind;
  readonly sessionId: AsyncSession['id'];
  readonly gameId: AsyncSession['gameId'];
  readonly pendingSince: Timestamp;
}

// ---------------------------------------------------------------------------
// 1. Persistence / inactivity (Requirement 7.11)
// ---------------------------------------------------------------------------

/**
 * Whether an asynchronous session remains active. It is active **iff** it has
 * not reached a terminal state and its pairing has not been dissolved. The
 * duration of partner inactivity is intentionally not an input: no amount of
 * inactivity can end the session (Requirement 7.11). Only a terminal state or a
 * dissolved pairing does.
 */
export function isAsyncSessionActive(
  session: Pick<AsyncSession, 'state'>,
  pairing: Pick<Pairing, 'status'>,
): boolean {
  return session.state !== 'terminal' && pairing.status !== 'dissolved';
}

// ---------------------------------------------------------------------------
// 2. 48-hour nudge (Requirement 7.12)
// ---------------------------------------------------------------------------

/**
 * Whether a 48-hour turn nudge is due: true when the session is still active
 * (not terminal) and the current turn has been pending for the
 * Active_Turn_Holder for at least {@link TURN_NUDGE_THRESHOLD_MS}. Uses `>=` so
 * the nudge is due exactly at the 48-hour boundary.
 */
export function isTurnNudgeDue(
  session: Pick<AsyncSession, 'state' | 'turnPendingSince'>,
  now: Timestamp,
): boolean {
  if (session.state === 'terminal') return false;
  return now - session.turnPendingSince >= TURN_NUDGE_THRESHOLD_MS;
}

/**
 * Derive the 48-hour reminder notification for the Active_Turn_Holder, or
 * `null` when no nudge is due (the session is terminal or the turn has been
 * pending for less than 48 hours). This is a pure read-only derivation: it never
 * forfeits or terminates the session — the session's persistence is governed
 * solely by {@link isAsyncSessionActive} (Requirement 7.12).
 *
 * `notificationId` is supplied by the caller (the durable id is assigned where
 * the row is created) so this function stays free of id generation.
 */
export function deriveTurnNudge(
  session: Pick<AsyncSession, 'id' | 'gameId' | 'state' | 'activeTurnHolder' | 'turnPendingSince'>,
  now: Timestamp,
  notificationId: NotificationId,
): Notification | null {
  if (!isTurnNudgeDue(session, now)) return null;

  const payload: AsyncTurnNotificationPayload = {
    kind: 'turn_reminder',
    sessionId: session.id,
    gameId: session.gameId,
    pendingSince: session.turnPendingSince,
  };

  return {
    id: notificationId,
    recipientAccountId: session.activeTurnHolder,
    category: ASYNC_TURN_CATEGORY,
    payload,
    createdAt: now,
    // One reminder per pending turn: keyed by the turn's pending-since instant.
    dedupeKey: `async_turn:turn_reminder:${session.id}:${session.turnPendingSince}`,
    acknowledgedAt: null,
    deliveredAt: null,
  };
}

// ---------------------------------------------------------------------------
// 3. Turn hand-off (Requirement 7.6)
// ---------------------------------------------------------------------------

/**
 * Derive the "your turn" notification produced when a valid turn completes and
 * ownership transfers. `session` is the session **after** the turn has been
 * applied, so `session.activeTurnHolder` is the partner who has just become the
 * new Active_Turn_Holder and is the notification's recipient (Requirement 7.6).
 *
 * `notificationId` is supplied by the caller for the same reason as in
 * {@link deriveTurnNudge}.
 */
export function deriveTurnHandoffNotification(
  session: Pick<AsyncSession, 'id' | 'gameId' | 'activeTurnHolder' | 'turnPendingSince'>,
  now: Timestamp,
  notificationId: NotificationId,
): Notification {
  const payload: AsyncTurnNotificationPayload = {
    kind: 'your_turn',
    sessionId: session.id,
    gameId: session.gameId,
    pendingSince: session.turnPendingSince,
  };

  return {
    id: notificationId,
    recipientAccountId: session.activeTurnHolder,
    category: ASYNC_TURN_CATEGORY,
    payload,
    createdAt: now,
    // One hand-off per new turn: keyed by the fresh turn's pending-since instant.
    dedupeKey: `async_turn:your_turn:${session.id}:${session.turnPendingSince}`,
    acknowledgedAt: null,
    deliveredAt: null,
  };
}
