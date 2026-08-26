/**
 * Account lockout evaluator (Requirement 2.3).
 *
 * `computeLockout` is a **pure, deterministic** function: given an account's
 * ordered authentication-attempt history and a reference time `now`, it reports
 * whether authentication is currently locked and, if so, until when.
 *
 * Policy (Req 2.3): 5 *consecutive* failed attempts for an account within a
 * 15-minute window lock the account for 15 minutes. "Consecutive" means a
 * successful attempt resets the failure streak; "within a 15-minute window"
 * means the span from the first to the fifth of the relevant failures is at most
 * 15 minutes. The lock takes effect at the fifth failure and lasts 15 minutes.
 *
 * This function performs no I/O and does not read the wall clock; the caller
 * supplies `now`. It is exercised by the Property 7 test (task 3.6).
 */
import type { Timestamp } from './common.js';

/** Number of consecutive failures within the window that triggers a lock. */
export const LOCKOUT_THRESHOLD = 5;

/** The sliding window in which the failures must fall (15 minutes). */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/** How long the account stays locked once triggered (15 minutes). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** A single authentication attempt in the account's history. */
export interface AuthAttemptEvent {
  /** When the attempt occurred. */
  readonly at: Timestamp;
  /** Whether the attempt succeeded. A success resets the failure streak. */
  readonly success: boolean;
}

/**
 * Current lockout state. `locked` is true iff a lock is in effect at `now`;
 * `lockedUntil` is the timestamp the lock expires (only meaningful, and only
 * non-null, when `locked` is true).
 */
export interface LockoutStatus {
  readonly locked: boolean;
  readonly lockedUntil: Timestamp | null;
}

/**
 * Evaluate whether an account is locked at `now` given its attempt history.
 *
 * The history may be in any order and may include attempts after `now`; only
 * attempts at or before `now` are considered, sorted chronologically. The
 * function scans the failure streak, and each time the most recent
 * `LOCKOUT_THRESHOLD` failures span no more than `LOCKOUT_WINDOW_MS`, it records
 * a lock triggered at that (fifth) failure. The account is locked at `now` iff
 * the most recent such trigger is still within its `LOCKOUT_DURATION_MS`.
 */
export function computeLockout(
  attempts: readonly AuthAttemptEvent[],
  now: Timestamp,
): LockoutStatus {
  const chronological = attempts
    .filter((attempt) => attempt.at <= now)
    .slice()
    .sort((a, b) => a.at - b.at);

  let streak: Timestamp[] = [];
  let latestTrigger: Timestamp | null = null;

  for (const attempt of chronological) {
    if (attempt.success) {
      streak = [];
      continue;
    }
    streak.push(attempt.at);
    if (streak.length >= LOCKOUT_THRESHOLD) {
      const windowStart = streak[streak.length - LOCKOUT_THRESHOLD];
      if (windowStart !== undefined && attempt.at - windowStart <= LOCKOUT_WINDOW_MS) {
        latestTrigger = attempt.at;
      }
    }
  }

  if (latestTrigger === null) {
    return { locked: false, lockedUntil: null };
  }

  const lockedUntil = latestTrigger + LOCKOUT_DURATION_MS;
  return now < lockedUntil ? { locked: true, lockedUntil } : { locked: false, lockedUntil: null };
}
