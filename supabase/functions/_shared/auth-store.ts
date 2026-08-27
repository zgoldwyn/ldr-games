// Server-authoritative auth state store for the Edge Functions (task 12.3).
//
// This module wires the pure, property-tested evaluators from `@ldr/core` to
// the `auth_attempts` (lockout) and `account_session` (single-session +
// inactivity) tables. It intentionally holds no policy of its own: the lockout
// decision is delegated to `computeLockout` (Req 2.3) and the inactivity
// decision to `isWithinInactivityWindow` (Req 2.6). It provides:
//
//   - recordFailedAttempt / resetAuthAttempts / readLockout  (Req 2.3)
//   - terminateSession                                        (Req 2.4, 2.5)
//   - touchLastActivity / enforceInactivity                   (Req 2.6)
//
// The lockout functions are imported by the login Edge Function (task 12.2):
// it reads the lockout state before verifying credentials, records a failure on
// a bad attempt, and resets the counter on a successful sign-in.

import { type SupabaseClient } from "@supabase/supabase-js";
import {
  type AuthAttemptEvent,
  computeLockout,
  isWithinInactivityWindow,
  LOCKOUT_WINDOW_MS,
  type LockoutStatus,
  type Timestamp,
} from "./core.ts";

const AUTH_ATTEMPTS = "auth_attempts";
const ACCOUNT_SESSION = "account_session";

/** The consecutive-failure aggregate tracked per account in `auth_attempts`. */
interface AttemptAggregate {
  readonly failedCount: number;
  readonly windowStart: Timestamp;
  readonly lockedUntil: Timestamp | null;
}

/** Parse a nullable Postgres `timestamptz` (ISO string) into epoch millis. */
function toMillis(value: string | null): Timestamp | null {
  return value === null ? null : Date.parse(value);
}

/** Render epoch millis as an ISO string for a Postgres `timestamptz` column. */
function toIso(value: Timestamp): string {
  return new Date(value).toISOString();
}

/**
 * Reconstruct the consecutive-failure event stream that `computeLockout`
 * consumes from the compact per-account aggregate. All but the most recent
 * failure are pinned to the window start and the most recent is placed at
 * `latest`, which preserves the exact span the 15-minute policy measures across
 * the 5 most recent failures while keeping the pure evaluator authoritative.
 */
function reconstructAttempts(
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
 * `computeLockout` evaluator. Exported for unit testing without a database.
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

/** Read the current attempt aggregate for an account, or a fresh default. */
async function readAggregate(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
): Promise<AttemptAggregate> {
  const { data, error } = await admin
    .from(AUTH_ATTEMPTS)
    .select("failed_count, window_start, locked_until")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { failedCount: 0, windowStart: now, lockedUntil: null };
  }
  return {
    failedCount: data.failed_count as number,
    windowStart: toMillis(data.window_start as string) ?? now,
    lockedUntil: toMillis(data.locked_until as string | null),
  };
}

/**
 * Read whether authentication is currently locked for an account (Req 2.3).
 * `locked_until` in the row is the persisted source of truth; a lock is in
 * effect iff it is set and still in the future.
 */
export async function readLockout(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
): Promise<LockoutStatus> {
  const aggregate = await readAggregate(admin, accountId, now);
  if (aggregate.lockedUntil !== null && now < aggregate.lockedUntil) {
    return { locked: true, lockedUntil: aggregate.lockedUntil };
  }
  return { locked: false, lockedUntil: null };
}

/**
 * Record a failed authentication attempt and, when the policy is met, set
 * `locked_until` (Req 2.3). Consecutive failures accumulate within a rolling
 * 15-minute window; a failure arriving after the window has elapsed starts a
 * fresh window. Returns the resulting lockout status.
 */
export async function recordFailedAttempt(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
): Promise<LockoutStatus> {
  const current = await readAggregate(admin, accountId, now);

  const windowExpired = now - current.windowStart > LOCKOUT_WINDOW_MS;
  const windowStart = windowExpired ? now : current.windowStart;
  const failedCount = windowExpired ? 1 : current.failedCount + 1;

  const status = decideLockout({ windowStart, failedCount, lockedUntil: null }, now);

  const { error } = await admin.from(AUTH_ATTEMPTS).upsert(
    {
      account_id: accountId,
      failed_count: failedCount,
      window_start: toIso(windowStart),
      locked_until: status.lockedUntil === null ? null : toIso(status.lockedUntil),
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;

  return status;
}

/**
 * Reset the failed-attempt counter for an account after a successful sign-in
 * (Req 2.3 — failures must be *consecutive*, so a success clears the streak and
 * any lock).
 */
export async function resetAuthAttempts(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
): Promise<void> {
  const { error } = await admin.from(AUTH_ATTEMPTS).upsert(
    {
      account_id: accountId,
      failed_count: 0,
      window_start: toIso(now),
      locked_until: null,
    },
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

/**
 * Terminate the Authenticated_Session for an account (Req 2.4, 2.5).
 *
 * Termination bumps the account's session `epoch` so any outstanding access
 * token becomes stale under the epoch guard (the same mechanism that displaces
 * a superseded client), and revokes the underlying Supabase refresh tokens so
 * the session cannot be silently refreshed. Once terminated the account has no
 * valid session, so shared-feature access is denied and the client is routed to
 * sign-in (Req 2.5).
 */
export async function terminateSession(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
  accessToken?: string | null,
): Promise<void> {
  const { data, error: readError } = await admin
    .from(ACCOUNT_SESSION)
    .select("epoch")
    .eq("account_id", accountId)
    .maybeSingle();
  if (readError) throw readError;

  const nextEpoch = ((data?.epoch as number | undefined) ?? 0) + 1;
  const iso = toIso(now);

  const { error: writeError } = await admin.from(ACCOUNT_SESSION).upsert(
    {
      account_id: accountId,
      epoch: nextEpoch,
      last_activity_at: iso,
      updated_at: iso,
    },
    { onConflict: "account_id" },
  );
  if (writeError) throw writeError;

  // Best-effort revocation of the refresh/access tokens. The epoch bump above
  // is the authoritative termination; token revocation is defence in depth and
  // must not fail the sign-out if the token is already gone.
  if (accessToken) {
    try {
      await admin.auth.admin.signOut(accessToken);
    } catch {
      // Already revoked or unsupported locally — the epoch guard still denies it.
    }
  }
}

/**
 * Record user activity by advancing `last_activity_at` to `now` (Req 2.6). This
 * is what keeps an actively-used session alive against the 30-day inactivity
 * expiry evaluated by {@link isWithinInactivityWindow}.
 */
export async function touchLastActivity(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
): Promise<void> {
  const iso = toIso(now);
  const { error } = await admin
    .from(ACCOUNT_SESSION)
    .update({ last_activity_at: iso, updated_at: iso })
    .eq("account_id", accountId);
  if (error) throw error;
}

/** Result of an inactivity check for a session. */
export interface InactivityResult {
  /** Whether the session is still within the 30-day inactivity window. */
  readonly valid: boolean;
  /** The last recorded activity time, or null if no session row exists. */
  readonly lastActivityAt: Timestamp | null;
}

/**
 * Enforce the 30-day inactivity expiry for an account's session (Req 2.6).
 *
 * If the session has seen no activity for 30 consecutive days it is invalidated
 * (its epoch is bumped so the token is denied) and `valid: false` is returned,
 * requiring the user to sign in again. Otherwise `last_activity_at` is advanced
 * to `now` and `valid: true` is returned.
 */
export async function enforceInactivity(
  admin: SupabaseClient,
  accountId: string,
  now: Timestamp,
  accessToken?: string | null,
): Promise<InactivityResult> {
  const { data, error } = await admin
    .from(ACCOUNT_SESSION)
    .select("last_activity_at")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;

  const lastActivityAt = toMillis((data?.last_activity_at as string | null) ?? null);
  if (lastActivityAt === null) {
    // No session registry row: treat as no valid session (Req 2.5).
    return { valid: false, lastActivityAt: null };
  }

  if (!isWithinInactivityWindow(lastActivityAt, now)) {
    await terminateSession(admin, accountId, now, accessToken);
    return { valid: false, lastActivityAt };
  }

  await touchLastActivity(admin, accountId, now);
  return { valid: true, lastActivityAt: now };
}
