// Presence evaluation helpers for the real-time game pause / rejoin
// transitions (Requirements 6.6, 6.7, 6.8).
//
// This module is PURE: no Deno APIs, no database access, no clock reads. Every
// time-dependent input (`now`, `lastSeenAt`) is passed in explicitly, mirroring
// the style of the shared `@ldr/core` domain modules so the 30-second
// disconnect decision is deterministic and reviewable. The database and
// Realtime wiring lives in `rt-presence-store.ts`; the authoritative session
// transitions themselves come from `@ldr/core/rt-session`
// (`pauseSession` / `resumeSession`), which already preserve and restore the
// game state.

/**
 * Continuous loss of connectivity that pauses an active real-time session
 * (30 seconds, Requirement 6.6).
 */
export const DISCONNECT_THRESHOLD_MS = 30 * 1000;

/** Realtime Broadcast events published on a game channel by these functions. */
export const RT_EVENTS = {
  /** The session was paused after a 30s partner disconnect (Req 6.6). */
  paused: "paused",
  /** The session resumed from the preserved state on rejoin (Req 6.7). */
  resumed: "resumed",
  /** The session is terminal; the recorded outcome is presented (Req 6.8). */
  outcome: "outcome",
} as const;

// NOTE: the Realtime topic these events are published on is named in exactly one
// place — `gameChannelTopic` in `_shared/realtime.ts` — and is shared with the
// authoritative move fan-out in `rt-move`, so `paused` / `resumed` / `outcome`
// arrive on the same channel a playing client is already subscribed to. It is
// not re-exported here because this module is kept free of Deno-dependent
// imports.

/**
 * One partner's connectivity as observed through Realtime Presence on the game
 * channel. `lastSeenAt` is the last instant that partner was seen present; it
 * is what turns a momentary absence into a *continuous* 30-second disconnect.
 */
export interface PresenceSample {
  readonly accountId: string;
  readonly online: boolean;
  readonly lastSeenAt: number;
}

/** The two accounts that make up the pairing playing a session. */
export interface PairingMembers {
  readonly a: string;
  readonly b: string;
}

/**
 * How long a partner has been continuously absent as of `now`. An online
 * partner is never absent (0). A `lastSeenAt` in the future is clamped to 0 so
 * a client cannot manufacture a disconnect by reporting a skewed clock.
 */
export function offlineDurationMs(
  sample: PresenceSample,
  now: number,
): number {
  if (sample.online) return 0;
  return Math.max(0, now - sample.lastSeenAt);
}

/**
 * Whether a partner has been absent for the full 30-second window
 * (Requirement 6.6). Uses `>=` so the pause becomes due exactly at 30s.
 */
export function isDisconnected(sample: PresenceSample, now: number): boolean {
  return offlineDurationMs(sample, now) >= DISCONNECT_THRESHOLD_MS;
}

/**
 * The pairing member whose disconnect has lasted 30 continuous seconds, or
 * `null` when neither has (so the session keeps playing).
 *
 * Samples for accounts outside the pairing are ignored. A member with no sample
 * at all is *not* treated as disconnected: without a `lastSeenAt` there is no
 * evidence of a continuous 30-second absence. When both members qualify the
 * longest-absent one is chosen, with the lexicographically smaller account id
 * breaking an exact tie, so the decision is deterministic.
 */
export function findDisconnectedMember(
  samples: readonly PresenceSample[],
  members: PairingMembers,
  now: number,
): string | null {
  let chosen: string | null = null;
  let chosenDuration = -1;

  for (const sample of samples) {
    if (sample.accountId !== members.a && sample.accountId !== members.b) {
      continue;
    }
    if (!isDisconnected(sample, now)) continue;

    const duration = offlineDurationMs(sample, now);
    const wins = duration > chosenDuration ||
      (duration === chosenDuration && chosen !== null &&
        sample.accountId < chosen);
    if (wins) {
      chosen = sample.accountId;
      chosenDuration = duration;
    }
  }

  return chosen;
}

/**
 * The partner still connected when `disconnected` dropped out — the recipient
 * of the pause notification (Requirement 6.6). Returns `null` if the supplied
 * account is not a member of the pairing.
 */
export function remainingMember(
  members: PairingMembers,
  disconnected: string,
): string | null {
  if (disconnected === members.a) return members.b;
  if (disconnected === members.b) return members.a;
  return null;
}

/** Whether an account is one of the pairing's two members. */
export function isMember(
  members: PairingMembers,
  accountId: string,
): boolean {
  return accountId === members.a || accountId === members.b;
}

// ---------------------------------------------------------------------------
// Session row <-> snapshot mapping
// ---------------------------------------------------------------------------

/** Lifecycle states of the `rt_sessions.state` enum. */
export type RTSessionState = "pending" | "active" | "paused" | "terminal";

/** The recorded result of a finished session (Requirement 6.8). */
export interface RTOutcome {
  readonly kind: "completed" | "ended_without_outcome";
  readonly winner: string | null;
  readonly recordedAt: number;
}

/** A `rt_sessions` row as returned by PostgREST. */
export interface RTSessionRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly game_id: string;
  readonly state: RTSessionState;
  readonly game_state: Record<string, unknown> | null;
  readonly outcome: RTOutcome | null;
  readonly pending_since: string | null;
  readonly paused_since: string | null;
}

/**
 * The camelCase session shape used by the pure `@ldr/core` transitions and
 * returned to clients. Structurally identical to the core `RTSession` (whose
 * ids are compile-time branded strings).
 */
export interface RTSessionSnapshot {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: RTSessionState;
  readonly gameState: Record<string, unknown>;
  readonly pendingSince?: number;
  readonly pausedSince?: number;
  readonly outcome?: RTOutcome;
}

/** Parse a nullable timestamptz into epoch milliseconds, or `undefined`. */
export function parseTimestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Map a `rt_sessions` row to the snapshot the pure transitions operate on. */
export function toSnapshot(row: RTSessionRow): RTSessionSnapshot {
  return {
    id: row.id,
    pairingId: row.pairing_id,
    gameId: row.game_id,
    state: row.state,
    gameState: row.game_state ?? {},
    ...(parseTimestamp(row.pending_since) === undefined
      ? {}
      : { pendingSince: parseTimestamp(row.pending_since) as number }),
    ...(parseTimestamp(row.paused_since) === undefined
      ? {}
      : { pausedSince: parseTimestamp(row.paused_since) as number }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
  };
}

// ---------------------------------------------------------------------------
// Notification derivation (Requirement 6.6)
// ---------------------------------------------------------------------------

/** Payload of the "your partner dropped out" notification. */
export interface RTPausedNotificationPayload {
  readonly type: "rt_session_paused";
  readonly sessionId: string;
  readonly gameId: string;
  /** The partner whose 30s disconnect paused the session. */
  readonly disconnectedPartner: string;
  /** When the pause took effect; the 5-minute rejoin window runs from here. */
  readonly pausedSince: number;
}

/** A `notifications` insert row (snake_case, as the table expects). */
export interface NotificationInsert {
  readonly recipient_account_id: string;
  readonly category: string;
  readonly payload: Record<string, unknown>;
  readonly dedupe_key: string;
}

/**
 * Derive the notification delivered to the partner who is still connected when
 * the session pauses (Requirement 6.6). Keyed by the pause instant so a session
 * that pauses repeatedly produces one notification per pause, while a retried
 * report of the *same* pause dedupes to a single row (Requirement 11.6).
 */
export function pausedNotification(
  args: {
    readonly recipient: string;
    readonly sessionId: string;
    readonly gameId: string;
    readonly disconnectedPartner: string;
    readonly pausedSince: number;
  },
): NotificationInsert {
  const payload: RTPausedNotificationPayload = {
    type: "rt_session_paused",
    sessionId: args.sessionId,
    gameId: args.gameId,
    disconnectedPartner: args.disconnectedPartner,
    pausedSince: args.pausedSince,
  };

  return {
    recipient_account_id: args.recipient,
    category: "system",
    payload: payload as unknown as Record<string, unknown>,
    dedupe_key:
      `rt-session-paused:${args.sessionId}:${args.pausedSince}:${args.recipient}`,
  };
}
