/**
 * Client-side Realtime Presence tracking (Requirement 6.6).
 *
 * This is the half of the pause path that task 15.2 deferred. `rt-presence` is
 * the authority on what a 30-second disconnect means — it re-evaluates the
 * window server-side and clamps a skewed `lastSeenAt` so a hostile client cannot
 * fabricate a pause — but it is a request/response function. Something has to
 * notice the partner left and call it. That is this module plus the reporting
 * schedule in `connection-manager.ts`.
 *
 * Everything here is PURE, in the style of `sync/connectivity.ts`: Presence
 * events are folded into a roster with `now` passed in, no timers and no clock
 * reads. What makes the 30-second rule work is one property that is easy to get
 * wrong — `lastSeenAt` must be preserved while a partner stays absent. Realtime
 * re-emits `sync` frequently, and refreshing `lastSeenAt` on each one would keep
 * restarting the absence clock so the window never accumulates and the session
 * would never pause.
 */
import type { AccountId, Timestamp } from '../domain/common.js';
import type { PresenceState } from '../domain/game.js';

/**
 * Continuous absence that pauses an active session (30 seconds, Req 6.6).
 *
 * This MIRRORS `DISCONNECT_THRESHOLD_MS` in
 * `supabase/functions/_shared/rt-presence.ts`, which is the value that actually
 * decides. Here it only schedules when to report, so a drift between the two
 * costs a slightly early or late report — the server still refuses to pause
 * before the real threshold — rather than a wrong pause.
 */
export const DISCONNECT_THRESHOLD_MS = 30 * 1000;

/**
 * How often to re-report while a partner remains absent past the threshold.
 * The first report may lose a race with a concurrent move or an in-flight
 * rejoin, so reporting is repeated rather than one-shot.
 */
export const PRESENCE_REPORT_INTERVAL_MS = 10 * 1000;

/** Per-account connectivity as observed on the game channel. */
export interface PresenceRoster {
  readonly members: Readonly<Record<string, PresenceState>>;
}

/** A roster with nobody seen yet. */
export function emptyPresenceRoster(): PresenceRoster {
  return { members: {} };
}

function present(accountId: AccountId, now: Timestamp): PresenceState {
  return { accountId, online: true, lastSeenAt: now };
}

/**
 * Mark an account absent, PRESERVING an existing absence start.
 *
 * The `lastSeenAt` of an already-absent member is kept as-is: it is the instant
 * the continuous absence began, and moving it would restart the 30-second
 * window (Req 6.6).
 */
function absent(
  roster: PresenceRoster,
  accountId: AccountId,
  now: Timestamp,
): PresenceState {
  const existing = roster.members[accountId];
  if (existing !== undefined && !existing.online) return existing;
  return { accountId, online: false, lastSeenAt: now };
}

/**
 * Fold a Presence `sync` frame — the authoritative set of currently present
 * accounts — into the roster.
 *
 * Anyone known but missing from `presentIds` becomes absent. Accounts appearing
 * for the first time in `presentIds` are added, so a roster does not need to be
 * seeded before the first frame.
 */
export function applyPresenceSync(
  roster: PresenceRoster,
  presentIds: readonly AccountId[],
  now: Timestamp,
): PresenceRoster {
  const online = new Set<string>(presentIds);
  const members: Record<string, PresenceState> = {};

  for (const accountId of Object.keys(roster.members)) {
    members[accountId] = online.has(accountId)
      ? present(accountId as AccountId, now)
      : absent(roster, accountId as AccountId, now);
  }
  for (const accountId of presentIds) {
    members[accountId] = present(accountId, now);
  }

  return { members };
}

/** Fold a Presence `join` event into the roster; the absence clock restarts. */
export function applyPresenceJoin(
  roster: PresenceRoster,
  accountId: AccountId,
  now: Timestamp,
): PresenceRoster {
  return { members: { ...roster.members, [accountId]: present(accountId, now) } };
}

/** Fold a Presence `leave` event into the roster, starting the absence clock. */
export function applyPresenceLeave(
  roster: PresenceRoster,
  accountId: AccountId,
  now: Timestamp,
): PresenceRoster {
  return { members: { ...roster.members, [accountId]: absent(roster, accountId, now) } };
}

/**
 * The roster as the `presence` array `rt-presence` expects. The server ignores
 * entries for accounts outside the session's pairing, so sending the whole
 * roster is safe.
 */
export function presenceSamples(roster: PresenceRoster): readonly PresenceState[] {
  return Object.values(roster.members);
}

/** How long `accountId` has been continuously absent, or 0 while present. */
export function absenceMs(
  roster: PresenceRoster,
  accountId: AccountId,
  now: Timestamp,
): number {
  const member = roster.members[accountId];
  if (member === undefined || member.online) return 0;
  // Clamped like the server does, so a clock skew cannot report a negative or
  // fabricated absence.
  return Math.max(0, now - member.lastSeenAt);
}

/** The longest continuous absence across the roster, excluding `self`. */
export function longestAbsenceMs(
  roster: PresenceRoster,
  self: AccountId,
  now: Timestamp,
): number {
  let longest = 0;
  for (const accountId of Object.keys(roster.members)) {
    if (accountId === self) continue;
    longest = Math.max(longest, absenceMs(roster, accountId as AccountId, now));
  }
  return longest;
}

/**
 * Whether a partner has now been absent long enough that `rt-presence` should be
 * called (Req 6.6). `self` is excluded: a client cannot observe its own absence,
 * and reporting it would ask the server to pause the game on the reporter.
 */
export function shouldReportDisconnect(
  roster: PresenceRoster,
  self: AccountId,
  now: Timestamp,
): boolean {
  return longestAbsenceMs(roster, self, now) >= DISCONNECT_THRESHOLD_MS;
}

/**
 * Milliseconds until the next `rt-presence` report is due, or `null` when no
 * partner is absent and nothing needs reporting.
 *
 * Before the threshold this is the time remaining on the window, so a client
 * wakes exactly when the pause becomes due rather than polling throughout the
 * 30 seconds. After it, reports repeat on {@link PRESENCE_REPORT_INTERVAL_MS}.
 */
export function nextReportDelayMs(
  roster: PresenceRoster,
  self: AccountId,
  now: Timestamp,
): number | null {
  let soonest: number | null = null;
  for (const accountId of Object.keys(roster.members)) {
    if (accountId === self) continue;
    const member = roster.members[accountId];
    if (member === undefined || member.online) continue;

    const absent = absenceMs(roster, accountId as AccountId, now);
    const delay =
      absent >= DISCONNECT_THRESHOLD_MS
        ? PRESENCE_REPORT_INTERVAL_MS
        : DISCONNECT_THRESHOLD_MS - absent;
    soonest = soonest === null ? delay : Math.min(soonest, delay);
  }
  return soonest;
}
