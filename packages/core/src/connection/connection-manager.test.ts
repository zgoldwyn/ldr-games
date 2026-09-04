import { describe, expect, it, vi } from 'vitest';

import {
  accountId as toAccountId,
  pairingId as toPairingId,
  sessionId as toSessionId,
} from '../domain/common.js';
import { createAsyncGameModule } from '../games/async-game-module.js';
import { createRealTimeGameModule } from '../games/rt-game-module.js';
import { createLocalStore } from '../store/local-store.js';
import type { SyncPorts } from '../sync/sync-module.js';
import { createConnectionManager, type ConnectionPorts } from './connection-manager.js';
import { DISCONNECT_THRESHOLD_MS, PRESENCE_REPORT_INTERVAL_MS } from './presence.js';

// Unit tests for the Connection Manager (Req 2.9, 5.3, 5.4, 6.6).
//
// This module is wiring, so the tests are about routing and lifecycle: which
// arriving signal reaches which module, what a revoke must and must not do, and
// that a partner walking away eventually asks the server to pause. The 30-second
// rule itself is the server's (`rt-presence`) and the queue drain is the sync
// module's (task 14.2) — neither is re-tested here.

const ME = toAccountId('11111111-1111-4111-8111-111111111111');
const PARTNER = toAccountId('22222222-2222-4222-8222-222222222222');
const PAIRING = toPairingId('33333333-3333-4333-8333-333333333333');
const SESSION = toSessionId('55555555-5555-4555-8555-555555555555');
const T0 = 1_700_000_000_000;
const EPOCH = 7;

function board(cells: (string | null)[] = Array<string | null>(9).fill(null)) {
  return {
    game: 'tic-tac-toe',
    players: [ME, PARTNER],
    currentTurn: ME,
    status: 'in_progress',
    winner: null,
    board: cells,
  };
}

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    pairingId: PAIRING,
    gameId: 'tic-tac-toe',
    state: 'active',
    gameState: board(),
    outcome: null,
    ...overrides,
  };
}

function harness() {
  let clock = T0;
  const store = createLocalStore();

  // --- captured channel handlers, so a test can deliver events -------------
  let accountHandlers: Parameters<ConnectionPorts['subscribeAccount']>[1] | null = null;
  let gameHandlers: Parameters<ConnectionPorts['subscribeGameSession']>[2] | null = null;
  let syncHandlers: Parameters<SyncPorts['subscribePairing']>[1] | null = null;

  const teardowns = { account: 0, game: 0, sync: 0 };
  const presenceReports: { sessionId: string; samples: readonly unknown[] }[] = [];

  // --- injected timer, so scheduling is asserted rather than awaited -------
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;

  const ports: ConnectionPorts = {
    subscribeAccount: (_accountId, handlers) => {
      accountHandlers = handlers;
      return () => {
        teardowns.account += 1;
      };
    },
    subscribeGameSession: (_sessionId, _self, handlers) => {
      gameHandlers = handlers;
      return () => {
        teardowns.game += 1;
      };
    },
    reportPresence: async (sessionId, samples) => {
      presenceReports.push({ sessionId, samples });
    },
    now: () => clock,
    schedule: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
  };

  const syncPorts: SyncPorts = {
    subscribePairing: (_pairingId, handlers) => {
      syncHandlers = handlers;
      return () => {
        teardowns.sync += 1;
      };
    },
    postChanges: async () => [],
    now: () => clock,
  };

  const realTime = createRealTimeGameModule(
    {
      listGames: async () => ({ ok: true, games: [] }),
      invite: async () => ({ ok: true, session: sessionPayload() as never }),
      join: async () => ({ ok: true, session: sessionPayload() as never }),
      move: async () => ({ ok: true, session: sessionPayload() as never }),
      rejoin: async () => ({ ok: true, session: sessionPayload() as never }),
    },
    store,
  );

  const asyncGames = createAsyncGameModule(
    {
      start: async () => ({ ok: true, session: {} as never }),
      takeTurn: async () => ({ ok: true, session: {} as never }),
      fetchSessions: async () => [],
    },
    store,
  );

  const revoked = vi.fn();
  const pairingEnded = vi.fn();
  const gameInvite = vi.fn();

  const manager = createConnectionManager({
    ports,
    syncPorts,
    store,
    realTime,
    async: asyncGames,
    listeners: {
      onRevoked: revoked,
      onPairingEnded: pairingEnded,
      onGameInvite: gameInvite,
    },
  });

  return {
    manager,
    store,
    realTime,
    asyncGames,
    revoked,
    pairingEnded,
    gameInvite,
    teardowns,
    presenceReports,
    account: (event: string, payload: Record<string, unknown>) =>
      accountHandlers?.onEvent(event, payload),
    game: (event: string, payload: Record<string, unknown>) =>
      gameHandlers?.onEvent(event, payload),
    presenceSync: (ids: string[]) => gameHandlers?.onPresenceSync(ids as never),
    presenceLeave: (id: string) => gameHandlers?.onPresenceLeave(id as never),
    presenceJoin: (id: string) => gameHandlers?.onPresenceJoin(id as never),
    remoteChange: (table: string, row: Record<string, unknown>) =>
      syncHandlers?.onChange({ event: 'UPDATE', table, row }),
    channelStatus: (status: 'SUBSCRIBED' | 'CHANNEL_ERROR') =>
      syncHandlers?.onStatus(status),
    advance: (ms: number) => {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    /**
     * Let the in-flight presence report resolve. The next report is only armed
     * after the previous one settles, which is what stops a slow `rt-presence`
     * from stacking overlapping requests.
     */
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingTimers: () => timers.size,
  };
}

function connected() {
  const h = harness();
  h.manager.connect({ accountId: ME, pairingId: PAIRING, epoch: EPOCH });
  return h;
}

describe('ConnectionManager.connect', () => {
  it('opens the pairing and account subscriptions together', () => {
    const h = connected();
    // Both are needed before anything works: the pairing channel carries the
    // partner's data changes (Req 5.3), the account channel carries revoke.
    h.account('game_invite', { sessionId: SESSION });
    expect(h.gameInvite).toHaveBeenCalledTimes(1);
  });

  it('tears both down on disconnect', () => {
    const h = connected();
    h.manager.disconnect();
    expect(h.teardowns.account).toBe(1);
    expect(h.teardowns.sync).toBe(1);
  });

  it('replaces an existing connection rather than leaking channels', () => {
    const h = connected();
    h.manager.connect({ accountId: ME, pairingId: PAIRING, epoch: EPOCH + 1 });
    expect(h.teardowns.account).toBe(1);
    expect(h.teardowns.sync).toBe(1);
  });
});

describe('displacement sign-out (Req 2.9)', () => {
  it('signs out on a revoke carrying a NEWER epoch', () => {
    const h = connected();
    h.account('revoke', { epoch: EPOCH + 1, reason: 'superseded' });
    expect(h.revoked).toHaveBeenCalledWith('superseded');
  });

  it('ignores a revoke carrying our OWN epoch', () => {
    // `auth-login` broadcasts the revoke with the epoch it just minted — the one
    // THIS client now holds. Signing out on it would mean every successful login
    // immediately logs itself back out.
    const h = connected();
    h.account('revoke', { epoch: EPOCH, reason: 'superseded' });
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it('ignores a revoke carrying an older epoch', () => {
    const h = connected();
    h.account('revoke', { epoch: EPOCH - 1, reason: 'superseded' });
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it('ignores a revoke with no readable epoch', () => {
    // The epoch guard on the next request is the real authority (Req 2.8), so a
    // malformed signal is safe to drop rather than guess at.
    const h = connected();
    h.account('revoke', {});
    expect(h.revoked).not.toHaveBeenCalled();
  });

  it('tears down every channel and clears the cache when displaced', () => {
    const h = connected();
    h.store.put('rt_session', 'x', { id: 'x' });
    h.account('revoke', { epoch: EPOCH + 1, reason: 'superseded' });

    // The displaced client keeps no shared data: its token is already dead, so
    // anything still on screen is unbacked by the database (Req 2.9, 4.4).
    expect(h.teardowns.account).toBe(1);
    expect(h.teardowns.sync).toBe(1);
    expect(h.store.list('rt_session')).toHaveLength(0);
  });
});

describe('pairing dissolution (Req 4.2)', () => {
  it('clears cached shared data and notifies the shell', () => {
    const h = connected();
    h.store.put('async_session', 'a', { id: 'a' });
    h.store.put('notification', 'n', { id: 'n' });

    h.account('pairing_ended', { pairingId: PAIRING, terminatedSessions: [SESSION] });

    expect(h.pairingEnded).toHaveBeenCalledTimes(1);
    // RLS stops returning these rows the moment the pairing ends, so a cache
    // that kept them would be showing data the server would now refuse (Req 4.4).
    expect(h.store.list('async_session')).toHaveLength(0);
    expect(h.store.list('notification')).toHaveLength(0);
  });

  it('stops the game subscription too', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.account('pairing_ended', { pairingId: PAIRING });
    expect(h.teardowns.game).toBe(1);
  });
});

describe('game channel routing', () => {
  it('feeds an authoritative move into the real-time module (Req 6.4)', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.game('move', {
      ...sessionPayload({ gameState: board([PARTNER, ...Array(8).fill(null)]) }),
      actor: PARTNER,
    });

    const cached = h.realTime.cached(SESSION);
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(PARTNER);
  });

  it('feeds a pause into the real-time module (Req 6.6)', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.game('session_state', sessionPayload());
    h.game('paused', { sessionId: SESSION, gameState: board() });
    expect(h.realTime.cached(SESSION)?.state).toBe('paused');
  });

  it('replaces the game subscription when joining another session', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.manager.joinGame(toSessionId('66666666-6666-4666-8666-666666666666'));
    expect(h.teardowns.game).toBe(1);
  });

  it('leaves the game without dropping the account connection', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.manager.leaveGame();
    expect(h.teardowns.game).toBe(1);
    expect(h.teardowns.account).toBe(0);
  });
});

describe('presence reporting (Req 6.6)', () => {
  it('does not report while both partners are present', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.advance(60_000);
    expect(h.presenceReports).toHaveLength(0);
  });

  it('reports once the partner has been absent for 30 seconds', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.presenceLeave(PARTNER);

    // Nothing yet: the server would refuse to pause before the window closes.
    h.advance(DISCONNECT_THRESHOLD_MS - 1_000);
    expect(h.presenceReports).toHaveLength(0);

    h.advance(1_000);
    expect(h.presenceReports).toHaveLength(1);
    expect(h.presenceReports[0]?.sessionId).toBe(SESSION);
    expect(h.presenceReports[0]?.samples).toContainEqual(
      expect.objectContaining({ accountId: PARTNER, online: false }),
    );
  });

  it('does not report when the partner returns before the window closes', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.presenceLeave(PARTNER);

    h.advance(20_000);
    h.presenceJoin(PARTNER);
    h.advance(60_000);

    // Req 6.6 is about CONTINUOUS absence; a partner who blinked out is playing.
    expect(h.presenceReports).toHaveLength(0);
  });

  it('keeps reporting while the partner stays away', async () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.presenceLeave(PARTNER);

    h.advance(DISCONNECT_THRESHOLD_MS);
    expect(h.presenceReports).toHaveLength(1);

    // The next report is armed only once this one settles, so a slow
    // `rt-presence` cannot stack overlapping requests.
    await h.settle();
    h.advance(PRESENCE_REPORT_INTERVAL_MS);

    // The first report can lose a race with a concurrent move or an in-flight
    // rejoin, so it retries rather than firing once and giving up.
    expect(h.presenceReports).toHaveLength(2);
  });

  it('does not re-arm a report after leaving mid-flight', async () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.presenceLeave(PARTNER);

    h.advance(DISCONNECT_THRESHOLD_MS);
    h.manager.leaveGame();
    await h.settle();

    // The report was already in flight when the board closed; its completion
    // must not schedule another one against a session we have left.
    expect(h.pendingTimers()).toBe(0);
  });

  it('stops reporting after leaving the game', () => {
    const h = connected();
    h.manager.joinGame(SESSION);
    h.presenceSync([ME, PARTNER]);
    h.presenceLeave(PARTNER);
    h.manager.leaveGame();

    h.advance(120_000);
    expect(h.presenceReports).toHaveLength(0);
    // No orphaned timer keeping a phone awake after the board closed.
    expect(h.pendingTimers()).toBe(0);
  });
});

describe('Postgres Changes routing (Req 5.3, 7.3)', () => {
  it('feeds an async session row into the async module', () => {
    const h = connected();
    h.remoteChange('async_sessions', {
      id: SESSION,
      pairing_id: PAIRING,
      game_id: 'battleship',
      state: 'active',
      active_turn_holder: PARTNER,
      turn_pending_since: new Date(T0).toISOString(),
      game_state: { turns: [] },
      outcome: null,
    });

    expect(h.asyncGames.cached(SESSION)?.activeTurnHolder).toBe(PARTNER);
  });

  it('ignores a table it has no cache for', () => {
    const h = connected();
    expect(() => h.remoteChange('relationship_dates', { id: 'd1' })).not.toThrow();
    expect(h.store.list('async_session')).toHaveLength(0);
  });

  it('surfaces connectivity from the pairing channel (Req 5.4)', () => {
    const h = connected();
    h.channelStatus('SUBSCRIBED');
    expect(h.manager.connectivity().status).toBe('online');

    h.channelStatus('CHANNEL_ERROR');
    expect(h.manager.connectivity().indicatorVisible).toBe(true);
  });
});
