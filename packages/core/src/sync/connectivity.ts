/**
 * Client connectivity state and the connectivity-lost indicator (Requirement 5.4,
 * and the reconnection trigger for Requirement 5.5).
 *
 * This module is PURE: no timers, no sockets, no clock reads. Connectivity is
 * modeled as a state machine folded over observations — Realtime channel status
 * changes and explicit network signals from the shell — with `now` passed in.
 * That keeps "when does the indicator show" and "what counts as a reconnection"
 * deterministic and unit-testable, instead of being emergent behavior of a live
 * websocket.
 *
 * The design (design.md "Client Architecture") makes the Connection Manager
 * responsible for detecting connectivity loss and surfacing the indicator. The
 * signal it detects it from is the Supabase Realtime channel status, because a
 * subscribed pairing channel is exactly the thing whose loss means "changes are
 * no longer arriving within 5 seconds" (Req 5.3).
 *
 * Note what is deliberately NOT modeled here: connectivity loss is not an error.
 * Per design.md's error-handling table, transient connectivity is handled by
 * queueing locally and showing the indicator, never by failing the user's
 * action. So this module produces state, not a {@link Result}.
 */
import type { Timestamp } from '../domain/common.js';

/**
 * Status values a Supabase Realtime channel subscription reports. These mirror
 * `supabase-js`'s `REALTIME_SUBSCRIBE_STATES` rather than importing them, so this
 * module stays free of a runtime dependency on the client library and remains
 * usable from tests and from the Edge runtime.
 */
export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

/** Whether the client currently believes it can reach the backend. */
export type Connectivity = 'online' | 'offline';

/**
 * Observable connectivity state.
 *
 * `indicatorVisible` is the flag the shells render (Req 5.4). It is derived
 * rather than independent — it is simply `status === 'offline'` — but it is
 * exposed explicitly so the requirement maps to something a UI can bind to, and
 * so a future "reconnecting…" refinement has an obvious home.
 */
export interface ConnectivityState {
  readonly status: Connectivity;
  /** When the current `status` began, for "offline for Ns" messaging. */
  readonly since: Timestamp;
  /** True exactly while the connectivity-lost indicator must be shown (5.4). */
  readonly indicatorVisible: boolean;
}

/**
 * A connectivity observation. Channel status comes from the Realtime
 * subscription; `network` lets a shell feed in a platform signal (Expo
 * NetInfo, the browser `offline` event) that often notices loss sooner than a
 * socket timeout does.
 */
export type ConnectivityObservation =
  | { readonly kind: 'channel'; readonly status: ChannelStatus }
  | { readonly kind: 'network'; readonly online: boolean };

/**
 * Map a channel status to connectivity. Only `SUBSCRIBED` means online: a
 * channel that errored, timed out, or closed is not delivering partner changes,
 * which is indistinguishable from being offline as far as Req 5.3/5.4 go.
 */
export function connectivityFromChannelStatus(status: ChannelStatus): Connectivity {
  return status === 'SUBSCRIBED' ? 'online' : 'offline';
}

/**
 * The starting state. A client begins `offline` and only becomes online once a
 * subscription actually confirms — starting optimistically online would hide the
 * indicator during the initial connect and, worse, would send the first
 * mutations straight at the network instead of queueing them.
 */
export function initialConnectivity(now: Timestamp): ConnectivityState {
  return { status: 'offline', since: now, indicatorVisible: true };
}

/**
 * Fold one observation into the state.
 *
 * `since` only moves when the status actually CHANGES, so repeated identical
 * observations (a heartbeat re-reporting SUBSCRIBED, or a burst of channel
 * errors) neither reset the offline duration nor look like a reconnection.
 */
export function observeConnectivity(
  state: ConnectivityState,
  observation: ConnectivityObservation,
  now: Timestamp,
): ConnectivityState {
  const next: Connectivity =
    observation.kind === 'channel'
      ? connectivityFromChannelStatus(observation.status)
      : observation.online
        ? 'online'
        : 'offline';

  if (next === state.status) return state;

  return { status: next, since: now, indicatorVisible: next === 'offline' };
}

/** True while the client is offline and must hold mutations locally (5.4). */
export function isOffline(state: ConnectivityState): boolean {
  return state.status === 'offline';
}

/**
 * Whether moving from `before` to `after` is a RECONNECTION — the offline →
 * online edge that must trigger the queue drain (Req 5.5).
 *
 * This is an edge, not a level: it is true only on the transition, so a drain
 * fires once per reconnection rather than on every subsequent online
 * observation.
 */
export function isReconnection(
  before: ConnectivityState,
  after: ConnectivityState,
): boolean {
  return before.status === 'offline' && after.status === 'online';
}

/** How long the client has been in its current connectivity state. */
export function durationInState(state: ConnectivityState, now: Timestamp): number {
  return Math.max(0, now - state.since);
}
