/**
 * Session validity evaluators: single-session epoch and inactivity expiry
 * (Requirements 2.6, 2.7, 2.8).
 *
 * These are **pure, deterministic** helpers that back the custom single-session
 * registry. Two independent conditions govern whether a presented session token
 * is valid:
 *
 * 1. **Epoch (Req 2.7, 2.8):** the account's `account_session` registry holds a
 *    monotonically increasing `epoch` that increments on every new login. A
 *    token carries the epoch it was issued with; it is valid only while it still
 *    equals the registry's current epoch. A newer login raises the epoch, so all
 *    prior tokens become stale — this is what makes "only the newest client
 *    retains access" hold.
 * 2. **Inactivity (Req 2.6):** a session is valid only while the time since its
 *    last activity is strictly less than 30 days.
 *
 * The evaluators take `now` as an argument and read no clock or storage, so they
 * are fully deterministic and property-testable (Property 8 → task 3.7,
 * Property 9 → task 3.8).
 */
import { ERROR_CODES, type SessionError } from '../errors.js';
import { type Result, err, ok } from '../result.js';
import type { Timestamp } from './common.js';

/** The inactivity limit after which a session expires (30 days). */
export const INACTIVITY_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a token's epoch matches the account's current registry epoch. Only
 * the latest epoch is valid; any lower (stale) epoch has been superseded by a
 * newer login (Req 2.7, 2.8).
 */
export function isEpochCurrent(tokenEpoch: number, currentEpoch: number): boolean {
  return tokenEpoch === currentEpoch;
}

/**
 * Whether a session is still within the inactivity window: valid iff the delta
 * between `now` and the last activity time is strictly less than 30 days
 * (Req 2.6).
 */
export function isWithinInactivityWindow(lastActivityAt: Timestamp, now: Timestamp): boolean {
  return now - lastActivityAt < INACTIVITY_LIMIT_MS;
}

/** Inputs to {@link evaluateSession}. */
export interface SessionValidityInput {
  /** Epoch embedded in the presented token. */
  readonly tokenEpoch: number;
  /** Current epoch from the account's session registry. */
  readonly currentEpoch: number;
  /** When the session last saw user activity. */
  readonly lastActivityAt: Timestamp;
  /** Reference "current" time. */
  readonly now: Timestamp;
}

/**
 * Evaluate overall session validity against the epoch registry and the
 * inactivity window. Returns `ok(undefined)` when the session is valid, or an
 * error describing why it is not:
 *
 * - `SESSION_SUPERSEDED` — the token's epoch is stale (a newer login won).
 * - `SESSION_EXPIRED` — the session exceeded 30 days of inactivity.
 *
 * The epoch check takes precedence: a superseded session is reported as such
 * regardless of activity.
 */
export function evaluateSession(input: SessionValidityInput): Result<void, SessionError> {
  if (!isEpochCurrent(input.tokenEpoch, input.currentEpoch)) {
    return err({
      code: ERROR_CODES.SESSION_SUPERSEDED,
      message: 'Session was superseded by a more recent login.',
    });
  }
  if (!isWithinInactivityWindow(input.lastActivityAt, input.now)) {
    return err({
      code: ERROR_CODES.SESSION_EXPIRED,
      message: 'Session expired after 30 days of inactivity.',
    });
  }
  return ok(undefined);
}
