import { describe, expect, it } from 'vitest';

import { accountId as toAccountId, sessionId as toSessionId } from '../domain/common.js';
import { ERROR_CODES, type AsyncError } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { createLocalStore } from '../store/local-store.js';
import {
  asyncSessionFromPayload,
  asyncSessionFromRow,
  createAsyncGameModule,
  type AsyncGamePorts,
  type AsyncSessionPayload,
} from './async-game-module.js';

// Unit tests for the client AsyncGameModule (Req 7.1, 7.2, 7.5, 7.7, 7.8, 7.10).
//
// Stub ports rather than a Supabase client. Turn ownership, shot legality and the
// hand-off notification are server-side and already pinned in
// `__harness__/async-game.integration.test.ts`. What this module owns is the
// cache: that a rejection disturbs nothing, and that a late Postgres Changes row
// cannot rewind a board the player has already seen advance.

const ALICE = toAccountId('11111111-1111-4111-8111-111111111111');
const BOB = toAccountId('22222222-2222-4222-8222-222222222222');
const SESSION = toSessionId('55555555-5555-4555-8555-555555555555');
const NOW = 1_700_000_000_000;

function gameState(turns: number, overrides: Record<string, unknown> = {}) {
  return {
    gameId: 'battleship',
    players: [ALICE, BOB],
    activeTurnHolder: turns % 2 === 0 ? ALICE : BOB,
    status: 'active',
    winner: null,
    turns: Array.from({ length: turns }, (_, seq) => ({ seq, actor: ALICE, action: {} })),
    ruleset: { kind: 'battleship', size: 3, ships: {}, shots: {} },
    ...overrides,
  };
}

function payload(overrides: Partial<AsyncSessionPayload> = {}): AsyncSessionPayload {
  return {
    id: SESSION,
    pairingId: 'pairing-1',
    gameId: 'battleship',
    state: 'active',
    activeTurnHolder: ALICE,
    turnPendingSince: NOW,
    gameState: gameState(0),
    outcome: null,
    ...overrides,
  };
}

function refusal(code: AsyncError['code']) {
  return { ok: false as const, error: { code, message: code } };
}

function harness(
  options: {
    start?: AsyncGamePorts['start'];
    takeTurn?: AsyncGamePorts['takeTurn'];
    fetchSessions?: AsyncGamePorts['fetchSessions'];
  } = {},
) {
  const store = createLocalStore();
  const ports: AsyncGamePorts = {
    start: options.start ?? (async () => ({ ok: true, session: payload() })),
    takeTurn:
      options.takeTurn ??
      (async () => ({
        ok: true,
        session: payload({ activeTurnHolder: BOB, gameState: gameState(1) }),
      })),
    fetchSessions: options.fetchSessions ?? (async () => [payload()]),
  };
  return { module: createAsyncGameModule(ports, store), store };
}

describe('async payload and row mapping', () => {
  it('maps the Edge Function payload onto the domain shape', () => {
    const session = asyncSessionFromPayload(payload({ activeTurnHolder: BOB }));
    expect(session.id).toBe(SESSION);
    expect(session.activeTurnHolder).toBe(BOB);
    expect(session.turnPendingSince).toBe(NOW);
  });

  it('maps a Postgres Changes row, which is snake_case with an ISO timestamp', () => {
    // The two arrival paths genuinely differ: `async-take-turn` answers in
    // camelCase with epoch millis, while Realtime replays the raw row. A single
    // mapper would silently drop `active_turn_holder` and leave the board stuck
    // on the wrong player's turn.
    const session = asyncSessionFromRow({
      id: SESSION,
      pairing_id: 'pairing-1',
      game_id: 'battleship',
      state: 'active',
      active_turn_holder: BOB,
      turn_pending_since: new Date(NOW).toISOString(),
      game_state: gameState(2),
      outcome: null,
    });
    expect(session.activeTurnHolder).toBe(BOB);
    expect(session.turnPendingSince).toBe(NOW);
    expect(session.gameId).toBe('battleship');
  });

  it('omits outcome while the game is unfinished', () => {
    expect(asyncSessionFromPayload(payload({ outcome: null })).outcome).toBeUndefined();
  });

  it('carries a terminal outcome through (Req 7.10)', () => {
    const session = asyncSessionFromPayload(
      payload({
        state: 'terminal',
        outcome: { kind: 'completed', winner: ALICE, recordedAt: NOW },
      }),
    );
    expect(session.outcome).toMatchObject({ kind: 'completed', winner: ALICE });
  });
});

describe('AsyncGameModule.listGames (Req 7.1)', () => {
  it('offers battleship without a network call, so the list works offline', async () => {
    const games = harness().module.listGames();
    expect(games.map((g) => g.id)).toContain('battleship');
  });
});

describe('AsyncGameModule.start (Req 7.2, 7.9)', () => {
  it('caches the new session with its designated turn holder', async () => {
    const h = harness();
    const result = await h.module.start('battleship', {
      size: 3,
      ships: { [ALICE]: [{ row: 0, col: 0 }], [BOB]: [{ row: 1, col: 1 }] },
    });
    expect(isOk(result)).toBe(true);
    expect(h.module.cached(SESSION)?.activeTurnHolder).toBe(ALICE);
  });

  it('surfaces PAIRING_REQUIRED for an unpaired account (Req 7.9)', async () => {
    const h = harness({ start: async () => refusal(ERROR_CODES.PAIRING_REQUIRED) });
    const result = await h.module.start('battleship', {});
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
    expect(h.module.cached(SESSION)).toBeUndefined();
  });
});

describe('AsyncGameModule.takeTurn', () => {
  it('caches the transferred turn holder (Req 7.5)', async () => {
    const h = harness();
    await h.module.start('battleship', {});
    expect(h.module.cached(SESSION)?.activeTurnHolder).toBe(ALICE);

    const result = await h.module.takeTurn(SESSION, { kind: 'battleship.fire', row: 2, col: 2 });
    expect(isOk(result)).toBe(true);
    expect(h.module.cached(SESSION)?.activeTurnHolder).toBe(BOB);
  });

  it('leaves the cache untouched when the turn is not ours (Req 7.7)', async () => {
    const h = harness({ takeTurn: async () => refusal(ERROR_CODES.NOT_YOUR_TURN) });
    await h.module.start('battleship', {});
    const before = h.module.cached(SESSION);

    const result = await h.module.takeTurn(SESSION, { kind: 'battleship.fire', row: 2, col: 2 });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.NOT_YOUR_TURN);
    // Unlike a real-time rejection, `async-take-turn` echoes no state, so there
    // is nothing to resynchronise from — the cache must simply be left alone.
    expect(h.module.cached(SESSION)).toEqual(before);
  });

  it('leaves the cache untouched on an invalid shot (Req 7.8)', async () => {
    const h = harness({ takeTurn: async () => refusal(ERROR_CODES.INVALID_TURN) });
    await h.module.start('battleship', {});
    const before = h.module.cached(SESSION);
    await h.module.takeTurn(SESSION, { kind: 'battleship.fire', row: 99, col: 0 });
    expect(h.module.cached(SESSION)).toEqual(before);
  });
});

describe('AsyncGameModule remote arrivals', () => {
  it('applies a newer Postgres Changes row', async () => {
    const h = harness();
    await h.module.start('battleship', {});
    h.module.applyRemoteRow({
      id: SESSION,
      pairing_id: 'pairing-1',
      game_id: 'battleship',
      state: 'active',
      active_turn_holder: BOB,
      turn_pending_since: new Date(NOW + 1_000).toISOString(),
      game_state: gameState(1),
      outcome: null,
    });
    expect(h.module.cached(SESSION)?.activeTurnHolder).toBe(BOB);
  });

  it('ignores a row that is older than the state already applied', async () => {
    // The real hazard this guards: a `takeTurn` response and the Realtime replay
    // of the same commit race, and the replay can lose. Without the turn-count
    // version the board would visibly rewind one turn under the player.
    const h = harness({
      takeTurn: async () => ({
        ok: true,
        session: payload({ activeTurnHolder: BOB, gameState: gameState(3) }),
      }),
    });
    await h.module.start('battleship', {});
    await h.module.takeTurn(SESSION, { kind: 'battleship.fire', row: 2, col: 2 });

    h.module.applyRemoteRow({
      id: SESSION,
      pairing_id: 'pairing-1',
      game_id: 'battleship',
      state: 'active',
      active_turn_holder: ALICE,
      turn_pending_since: new Date(NOW).toISOString(),
      game_state: gameState(1),
      outcome: null,
    });

    const cached = h.module.cached(SESSION);
    expect((cached?.gameState as { turns: unknown[] }).turns).toHaveLength(3);
    expect(cached?.activeTurnHolder).toBe(BOB);
  });

  it('notifies subscribers so the board re-renders', async () => {
    const h = harness();
    let notified = 0;
    h.module.subscribe(() => {
      notified += 1;
    });
    await h.module.start('battleship', {});
    expect(notified).toBe(1);
  });
});

describe('AsyncGameModule.refresh and cached reads', () => {
  it('loads sessions into the cache for a cold start (Req 7.3)', async () => {
    const h = harness();
    await h.module.refresh();
    // An asynchronous game advances while you were away, so the list has to come
    // from the server at least once per launch.
    expect(h.module.list()).toHaveLength(1);
  });

  it('reads the last-known board without the network (Req 5.1)', async () => {
    const h = harness({
      fetchSessions: async () => {
        throw new Error('network is down');
      },
    });
    await h.module.start('battleship', {});
    expect(h.module.cached(SESSION)?.gameId).toBe('battleship');
  });

  it('reports whose turn it is, so a shell can disable the board (Req 7.4)', async () => {
    const h = harness();
    await h.module.start('battleship', {});
    expect(h.module.isMyTurn(SESSION, ALICE)).toBe(true);
    expect(h.module.isMyTurn(SESSION, BOB)).toBe(false);
  });

  it('reports no turn for an unknown session rather than throwing', () => {
    expect(harness().module.isMyTurn(toSessionId('unknown'), ALICE)).toBe(false);
  });
});
