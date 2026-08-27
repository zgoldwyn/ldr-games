// Account lockout evaluator for the auth Edge Functions (Requirement 2.3).
//
// Deno-compatible port of the pure helper that lives in the shared core package
// at `packages/core/src/domain/auth-lockout.ts`. The logic here is kept
// equivalent to that source of truth so the property-tested policy (Property 7,
// task 3.6) and this server-side enforcement never disagree.
//
// Why a port rather than an import: the `@ldr/core` package ships as an
// ESM/Node build (`.js` extension specifiers, workspace resolution) that the
// Deno edge runtime cannot resolve directly (see `auth-validation.ts` for the
// same rationale). `computeLockout` is pure and dependency-free, so porting it
// keeps the edge bundle self-contained. If the core policy changes, update both
// files together.

/** Epoch milliseconds (mirrors `@ldr/core` `Timestamp`). */
export type Timestamp = number;

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
 * `lockedUntil` is the timestamp the lock expires (only non-null when `locked`).
 */
export interface LockoutStatus {
  readonly locked: boolean;
  readonly lockedUntil: Timestamp | null;
}

/**
 * Evaluate whether an account is locked at `now` given its attempt history.
 *
 * The history may be in any order and may include attempts after `now`; only
 * attempts at or before `now` are considered, sorted chronologically. Each time
 * the most recent `LOCKOUT_THRESHOLD` failures span no more than
 * `LOCKOUT_WINDOW_MS`, a lock is recorded at that (fifth) failure. The account
 * is locked at `now` iff the most recent such trigger is still within its
 * `LOCKOUT_DURATION_MS`.
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
      if (
        windowStart !== undefined &&
        attempt.at - windowStart <= LOCKOUT_WINDOW_MS
      ) {
        latestTrigger = attempt.at;
      }
    }
  }

  if (latestTrigger === null) {
    return { locked: false, lockedUntil: null };
  }

  const lockedUntil = latestTrigger + LOCKOUT_DURATION_MS;
  return now < lockedUntil
    ? { locked: true, lockedUntil }
    : { locked: false, lockedUntil: null };
}
