/**
 * Connection Manager: Realtime channels, reconnect, and displacement sign-out
 * (Requirements 2.9, 5.3, 5.4, 6.6).
 *
 * This module COMPOSES rather than reimplements. Task 14.2 already built the
 * pairing-scoped Postgres Changes subscription, the connectivity state machine
 * and the reconnect queue drain, with injected ports specifically so this task
 * could wrap them — so `createSyncModule` is constructed here and delegated to,
 * not rewritten. What is genuinely new is the Broadcast side: the per-account
 * channel, the per-session game channel, Presence tracking, and the revoke that
 * forces a local sign-out.
 *
 * ROUTING IS THE WHOLE JOB. Three streams arrive and each has exactly one owner:
 *
 *   `account:{id}` Broadcast   revoke -> local sign-out (Req 2.9)
 *                              pairing_ended -> clear the cache (Req 4.2)
 *                              game_invite -> the shell (Req 6.2)
 *   `rt_session:{id}` Broadcast + Presence
 *                              session_state / move / paused / resumed / outcome
 *                              -> RealTimeGameModule (Req 6.3, 6.4, 6.6, 6.7, 6.8)
 *                              Presence -> the 30s disconnect report (Req 6.6)
 *   Postgres Changes           async_sessions -> AsyncGameModule (Req 7.3)
 *
 * WHY THE SYNC MODULE IS BUILT HERE. Its listeners are fixed at construction, so
 * handing it a pre-built instance would require the manager to exist first —
 * circular. Taking `SyncPorts` and constructing it lets the remote-change router
 * be wired straight in, and `sync` is exposed so a shell still reaches
 * `applyChange` and the queue.
 *
 * TIMERS AND CLOCKS ARE INJECTED. Presence reporting is a schedule, and a
 * schedule asserted through a fake timer is testable; one built on `setTimeout`
 * is a sleep in a test suite.
 */
import type { AccountId, PairingId, SessionId } from '../domain/common.js';
import type { PresenceState } from '../domain/game.js';
import type { AsyncGameModule, AsyncSessionRow } from '../games/async-game-module.js';
import type { RealTimeGameModule } from '../games/rt-game-module.js';
import type { LocalStore } from '../store/local-store.js';
import type { ChannelStatus, ConnectivityState } from '../sync/connectivity.js';
import {
  createSyncModule,
  type RemoteChange,
  type SyncModule,
  type SyncPorts,
} from '../sync/sync-module.js';
import {
  applyPresenceJoin,
  applyPresenceLeave,
  applyPresenceSync,
  emptyPresenceRoster,
  nextReportDelayMs,
  presenceSamples,
  shouldReportDisconnect,
  type PresenceRoster,
} from './presence.js';

/** Broadcast events carried on the per-account channel. */
export const ACCOUNT_EVENTS = {
  /** A newer sign-in displaced this client; sign out locally (Req 2.9). */
  revoke: 'revoke',
  /** The pairing was dissolved (Req 4.2). */
  pairingEnded: 'pairing_ended',
  /** The partner invited us to a real-time game (Req 6.2). */
  gameInvite: 'game_invite',
} as const;

/** Cancels a scheduled callback. */
export type CancelSchedule = () => void;

/** Injected collaborators for the channels this module owns. */
export interface ConnectionPorts {
  /**
   * Subscribe to `account:{accountId}` Broadcast. Returns an unsubscribe
   * function.
   */
  readonly subscribeAccount: (
    accountId: AccountId,
    handlers: {
      readonly onEvent: (event: string, payload: Record<string, unknown>) => void;
      readonly onStatus: (status: ChannelStatus) => void;
    },
  ) => () => void;

  /**
   * Subscribe to `rt_session:{sessionId}` for both Broadcast and Presence,
   * tracking `self` as present. One channel carries the whole stream, matching
   * the server's `gameChannelTopic`.
   */
  readonly subscribeGameSession: (
    sessionId: SessionId,
    self: AccountId,
    handlers: {
      readonly onEvent: (event: string, payload: Record<string, unknown>) => void;
      readonly onPresenceSync: (presentIds: readonly AccountId[]) => void;
      readonly onPresenceJoin: (accountId: AccountId) => void;
      readonly onPresenceLeave: (accountId: AccountId) => void;
      readonly onStatus: (status: ChannelStatus) => void;
    },
  ) => () => void;

  /** POST the Presence snapshot to `rt-presence` (Req 6.6). */
  readonly reportPresence: (
    sessionId: SessionId,
    samples: readonly PresenceState[],
  ) => Promise<void>;

  readonly now: () => number;

  /** Run `fn` after `ms`. Returns a canceller. */
  readonly schedule: (fn: () => void, ms: number) => CancelSchedule;
}

/** Listeners a shell attaches to react to account-directed signals. */
export interface ConnectionListeners {
  /**
   * This client was displaced and MUST sign out locally (Req 2.9). The channels
   * and cache are already torn down by the time this fires.
   */
  readonly onRevoked?: (reason: string) => void;
  /** The pairing was dissolved (Req 4.2). */
  readonly onPairingEnded?: (payload: Record<string, unknown>) => void;
  /** The partner invited us to a real-time game (Req 6.2). */
  readonly onGameInvite?: (payload: Record<string, unknown>) => void;
  /** Connectivity changed; drives the indicator (Req 5.4). */
  readonly onConnectivityChange?: (state: ConnectivityState) => void;
}

/** What `connect` needs to scope every subscription. */
export interface ConnectionIdentity {
  readonly accountId: AccountId;
  readonly pairingId: PairingId;
  /**
   * The session epoch this client holds. A `revoke` is obeyed only when it
   * carries a STRICTLY newer epoch.
   */
  readonly epoch: number;
}

export interface ConnectionManagerDeps {
  readonly ports: ConnectionPorts;
  readonly syncPorts: SyncPorts;
  readonly store: LocalStore;
  readonly realTime: RealTimeGameModule;
  readonly async: AsyncGameModule;
  readonly listeners?: ConnectionListeners;
}

export interface ConnectionManager {
  /** Open the account and pairing subscriptions (Req 5.3). */
  connect(identity: ConnectionIdentity): void;
  /** Tear everything down. */
  disconnect(): void;
  /** Subscribe to a real-time game's channel and start tracking Presence. */
  joinGame(sessionId: SessionId): void;
  /** Leave the current game channel, cancelling any presence schedule. */
  leaveGame(): void;
  /** Current connectivity, including the indicator flag (Req 5.4). */
  connectivity(): ConnectivityState;
  /** The composed sync module, for `applyChange` and queue inspection. */
  readonly sync: SyncModule;
}

/** Read a numeric field that Realtime may deliver as a number or a string. */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Build the Connection Manager. */
export function createConnectionManager(deps: ConnectionManagerDeps): ConnectionManager {
  const { ports, store, realTime, async: asyncGames } = deps;
  const listeners = deps.listeners ?? {};

  let identity: ConnectionIdentity | null = null;
  let accountTeardown: (() => void) | null = null;
  let gameTeardown: (() => void) | null = null;
  let activeSession: SessionId | null = null;
  let roster: PresenceRoster = emptyPresenceRoster();
  let cancelPresenceReport: CancelSchedule | null = null;

  const sync = createSyncModule(deps.syncPorts, {
    onRemoteChange: (change) => routeRemoteChange(change),
    onConnectivityChange: (state) => listeners.onConnectivityChange?.(state),
  });

  /**
   * Route a replicated row to the module that caches that table.
   *
   * Only `async_sessions` is handled: real-time state rides Broadcast (the fast
   * path Req 6.4's 2s budget depends on), and notifications have their own
   * recipient-scoped subscription in the notification module. An unhandled table
   * is not an error — the pairing subscription covers calendar and quiz tables
   * whose modules are deferred.
   */
  function routeRemoteChange(change: RemoteChange): void {
    if (change.table !== 'async_sessions') return;
    if (typeof change.row.id !== 'string') return;
    asyncGames.applyRemoteRow(change.row as unknown as AsyncSessionRow);
  }

  // -------------------------------------------------------------------------
  // Presence (Req 6.6)
  // -------------------------------------------------------------------------

  /**
   * Re-arm the presence report for the current roster.
   *
   * Scheduling rather than polling matters on a phone: with a partner absent
   * this wakes once when the pause becomes due, not thirty times while the
   * window runs down.
   */
  function schedulePresenceReport(): void {
    cancelPresenceReport?.();
    cancelPresenceReport = null;

    if (identity === null || activeSession === null) return;

    const delay = nextReportDelayMs(roster, identity.accountId, ports.now());
    if (delay === null) return;

    cancelPresenceReport = ports.schedule(() => {
      cancelPresenceReport = null;
      void firePresenceReport();
    }, delay);
  }

  async function firePresenceReport(): Promise<void> {
    const current = identity;
    const sessionId = activeSession;
    if (current === null || sessionId === null) return;

    if (shouldReportDisconnect(roster, current.accountId, ports.now())) {
      try {
        await ports.reportPresence(sessionId, presenceSamples(roster));
      } catch {
        // Best-effort. The report is retried on the next interval, and the
        // session is paused by whichever client reports successfully.
      }
    }

    // Only re-arm if we are still on the same session: a `leaveGame` during the
    // await must not resurrect the schedule.
    if (activeSession === sessionId) schedulePresenceReport();
  }

  function updateRoster(next: PresenceRoster): void {
    roster = next;
    schedulePresenceReport();
  }

  // -------------------------------------------------------------------------
  // Account channel (Req 2.9, 4.2, 6.2)
  // -------------------------------------------------------------------------

  /**
   * Tear down every subscription and drop all cached shared data.
   *
   * Used by both displacement and pairing dissolution: in each case the database
   * has already stopped returning these rows, so anything left in the cache is
   * data the server would now refuse (Req 2.9, 4.4).
   */
  function teardownAll(): void {
    leaveGame();
    accountTeardown?.();
    accountTeardown = null;
    sync.unsubscribe();
    identity = null;
    store.clear();
  }

  function handleAccountEvent(event: string, payload: Record<string, unknown>): void {
    if (event === ACCOUNT_EVENTS.revoke) {
      const current = identity;
      const epoch = readNumber(payload.epoch);
      // STRICTLY newer only. `auth-login` broadcasts the revoke with the epoch
      // it just minted — the very one this client now holds — so obeying `>=`
      // would make every successful sign-in immediately sign itself back out.
      // A malformed signal is dropped: the epoch guard rejects the stale token
      // on its next request anyway (Req 2.8), which is the real authority.
      if (current === null || epoch === null || epoch <= current.epoch) return;

      const reason = typeof payload.reason === 'string' ? payload.reason : 'superseded';
      teardownAll();
      listeners.onRevoked?.(reason);
      return;
    }

    if (event === ACCOUNT_EVENTS.pairingEnded) {
      teardownAll();
      listeners.onPairingEnded?.(payload);
      return;
    }

    if (event === ACCOUNT_EVENTS.gameInvite) {
      listeners.onGameInvite?.(payload);
    }
  }

  function leaveGame(): void {
    cancelPresenceReport?.();
    cancelPresenceReport = null;
    gameTeardown?.();
    gameTeardown = null;
    activeSession = null;
    roster = emptyPresenceRoster();
  }

  return {
    connect(next: ConnectionIdentity): void {
      // Replace wholesale, so reconnecting or signing in as another account
      // cannot leave a channel delivering the previous account's messages.
      teardownAll();
      identity = next;

      accountTeardown = ports.subscribeAccount(next.accountId, {
        onEvent: handleAccountEvent,
        // Connectivity is owned by the sync module's state machine, which reads
        // it from the pairing channel; a second source would fight it.
        onStatus: () => undefined,
      });

      sync.subscribe(next.pairingId);
    },

    disconnect(): void {
      teardownAll();
    },

    joinGame(sessionId: SessionId): void {
      const current = identity;
      if (current === null) return;

      leaveGame();
      activeSession = sessionId;

      gameTeardown = ports.subscribeGameSession(sessionId, current.accountId, {
        onEvent: (event, payload) => realTime.applyRemoteEvent(event, payload),
        onPresenceSync: (presentIds) =>
          updateRoster(applyPresenceSync(roster, presentIds, ports.now())),
        onPresenceJoin: (accountId) =>
          updateRoster(applyPresenceJoin(roster, accountId, ports.now())),
        onPresenceLeave: (accountId) =>
          updateRoster(applyPresenceLeave(roster, accountId, ports.now())),
        onStatus: () => undefined,
      });
    },

    leaveGame,

    connectivity(): ConnectivityState {
      return sync.connectivity();
    },

    sync,
  };
}
