// Pure lockout-tracking helpers bridging the compact `auth_attempts` aggregate
// to the shared `computeLockout` policy (Requirement 2.3).
//
// The `auth_attempts` table stores a per-account aggregate (a consecutive-
// failure count and the window start) rather than one row per attempt. These
// helpers translate that aggregate into the event stream `computeLockout`
// consumes, so the property-tested policy in `@ldr/core` stays the single
// source of truth for the 5-in-15-minutes rule. They are pure (no I/O) and
// exercised directly by `auth-store.test.ts`.
import {
  type AuthAttemptEvent,
  computeLockout,
  LOCKOUT_WINDOW_MS,
  type LockoutStatus,
  type Timestamp,
} from "./auth-lockout.ts";

/** The consecutive-failure aggregate tracked per account in `auth_attempts`. */
export interface AttemptAggregate {
  readonly failedCount: number;
  readonly windowStart: Timestamp;
  readonly lockedUntil: Timestamp | null;
}

/**
 * Reconstruct the consecutive-failure event stream that `computeLockout`
 * consumes from the compact aggregate. All but the most recent failure are
 * pinned to the window start and the most recent is placed at `latest`, which
 * preserves the exact span the 15-minute policy measures across the 5 most
 * recent failures while keeping the pure evaluator authoritative.
 */
export function reconstructAttempts(
  windowStart: Timestamp,
  failedCount: number,
  latest: Timestamp,
): AuthAttemptEvent[] {
  if (failedCount <= 0) return [];
  const events: AuthAttemptEvent[] = [];
  for (let i = 0; i < failedCount - 1; i += 1) {
    events.push({ at: windowStart, success: false });
  }
  events.push({ at: latest, success: false });
  return events;
}

/**
 * Pure lockout decision for an aggregate at `now`, delegated to the shared
 * `computeLockout` evaluator.
 */
export function decideLockout(
  aggregate: AttemptAggregate,
  now: Timestamp,
): LockoutStatus {
  const events = reconstructAttempts(
    aggregate.windowStart,
    aggregate.failedCount,
    now,
  );
  return computeLockout(events, now);
}

/** The next aggregate plus resulting lock status after recording a failure. */
export interface FailureOutcome {
  readonly aggregate: AttemptAggregate;
  readonly status: LockoutStatus;
}

/**
 * Compute the aggregate transition for a failed attempt at `now`. Consecutive
 * failures accumulate within the rolling 15-minute window; a failure arriving
 * after the window has elapsed starts a fresh window. When the policy is met
 * `status.locked` is true and `aggregate.lockedUntil` carries the expiry.
 */
export function applyFailure(
  current: AttemptAggregate,
  now: Timestamp,
): FailureOutcome {
  const windowExpired = now - current.windowStart > LOCKOUT_WINDOW_MS;
  const windowStart = windowExpired ? now : current.windowStart;
  const failedCount = windowExpired ? 1 : current.failedCount + 1;

  const status = decideLockout({ windowStart, failedCount, lockedUntil: null }, now);

  return {
    aggregate: { windowStart, failedCount, lockedUntil: status.lockedUntil },
    status,
  };
}
