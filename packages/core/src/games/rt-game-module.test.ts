import { describe, expect, it } from 'vitest';

import { accountId as toAccountId, sessionId as toSessionId } from '../domain/common.js';
import { ERROR_CODES, type RTError } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { createLocalStore } from '../store/local-store.js';
import {
  createRealTimeGameModule,
  rtSessionFromPayload,
  type RTGamePorts,
  type RTSessionPayload,
} from './rt-game-module.js';

// Unit tests for the client RealTimeGameModule (Req 6.1, 6.4, 6.11, plus 5.1).
//
// Stub ports rather than a Supabase client. Move legality, turn ownership and the
// Broadcast latency budget are all server-side and already pinned in
// `__harness__/realtime-game.integration.test.ts`. What this module owns is the
// cache: what is readable instantly, what a rejection must NOT disturb, and how a
// Broadcast-delivered state gets applied.

const ALICE = toAccountId('11111111-1111-4111-8111-111111111111');
const BOB = toAccountId('22222222-2222-4222-8222-222222222222');
const SESSION = toSessionId('55555555-5555-4555-8555-555555555555');

function board(cells: (string | null)[] = Array<string | null>(9).fill(null)) {
  return {
    game: 'tic-tac-toe',
    players: [ALICE, BOB],
    currentTurn: ALICE,
    status: 'in_progress',
    winner: null,
    board: cells,
  };
}

function payload(overrides: Partial<RTSessionPayload> = {}): RTSessionPayload {
  return {
    id: SESSION,
    pairingId: 'pairing-1',
    gameId: 'tic-tac-toe',
    state: 'active',
    gameState: board(),
    outcome: null,
    ...overrides,
  };
}

function refusal(code: RTError['code']) {
  return { ok: false as const, error: { code, message: code } };
}

function harness(
  options: {
    listGames?: RTGamePorts['listGames'];
    invite?: RTGamePorts['invite'];
    join?: RTGamePorts['join'];
    move?: RTGamePorts['move'];
    rejoin?: RTGamePorts['rejoin'];
  } = {},
) {
  let moveCalls = 0;
  const store = createLocalStore();

  const ports: RTGamePorts = {
    listGames:
      options.listGames ??
      (async () => ({ ok: true, games: [{ id: 'tic-tac-toe', name: 'Tic-Tac-Toe' }] })),
    invite: options.invite ?? (async () => ({ ok: true, session: payload({ state: 'pending' }) })),
    join: options.join ?? (async () => ({ ok: true, session: payload() })),
    move:
      options.move ??
      (async () => {
        moveCalls += 1;
        return { ok: true, session: payload({ gameState: board([ALICE, ...Array(8).fill(null)]) }) };
      }),
    rejoin: options.rejoin ?? (async () => ({ ok: true, session: payload() })),
  };

  return {
    module: createRealTimeGameModule(ports, store),
    store,
    moveCalls: () => moveCalls,
  };
}

describe('rtSessionFromPayload', () => {
  it('maps the wire session onto the domain shape', () => {
    const session = rtSessionFromPayload(payload({ state: 'paused' }));
    expect(session.id).toBe(SESSION);
    expect(session.state).toBe('paused');
    expect(session.gameId).toBe('tic-tac-toe');
  });

  it('omits outcome when the session has not finished', () => {
    // `outcome` is optional on RTSession; a literal null would read as "finished
    // with no result" to a shell checking for its presence.
    expect(rtSessionFromPayload(payload({ outcome: null })).outcome).toBeUndefined();
  });

  it('carries a recorded outcome through (Req 6.8)', () => {
    const session = rtSessionFromPayload(
      payload({
        state: 'terminal',
        outcome: { kind: 'completed', winner: ALICE, recordedAt: 1_700_000_000_000 },
      }),
    );
    expect(session.outcome).toMatchObject({ kind: 'completed', winner: ALICE });
  });
});

describe('RealTimeGameModule.listGames (Req 6.1)', () => {
  it('returns the catalog for a paired account', async () => {
    const result = await harness().module.listGames();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.map((g) => g.id)).toContain('tic-tac-toe');
  });

  it('surfaces PAIRING_REQUIRED for an unpaired account (Req 6.5)', async () => {
    const h = harness({ listGames: async () => refusal(ERROR_CODES.PAIRING_REQUIRED) });
    const result = await h.module.listGames();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
  });
});

describe('RealTimeGameModule.invite and join', () => {
  it('caches the pending session so it is readable instantly (Req 6.2)', async () => {
    const h = harness();
    const result = await h.module.invite('tic-tac-toe');
    expect(isOk(result)).toBe(true);
    // No await: the shell renders the waiting-for-partner screen on this frame.
    expect(h.module.cached(SESSION)?.state).toBe('pending');
  });

  it('caches the active session on join (Req 6.3)', async () => {
    const h = harness();
    await h.module.join(SESSION);
    expect(h.module.cached(SESSION)?.state).toBe('active');
  });

  it('does not cache anything when the invite is refused', async () => {
    const h = harness({ invite: async () => refusal(ERROR_CODES.PAIRING_REQUIRED) });
    await h.module.invite('tic-tac-toe');
    expect(h.module.cached(SESSION)).toBeUndefined();
  });
});

describe('RealTimeGameModule.move', () => {
  it('caches the authoritative post-move state (Req 6.4)', async () => {
    const h = harness();
    await h.module.join(SESSION);

    const result = await h.module.move(SESSION, { type: 'place', cell: 0 });
    expect(isOk(result)).toBe(true);

    const cached = h.module.cached(SESSION);
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(ALICE);
  });

  it('always reaches the server, even when the cached board says otherwise', async () => {
    // Tempting shortcut: run the shared pure `applyMove` first and skip the call
    // on a local reject. That is WRONG here — the cache lags the authoritative
    // row, so a move the server would accept (the partner has already played,
    // and it really is our turn) would be refused locally on stale state. The
    // server is the only authority on legality (Req 6.4, 6.11).
    const h = harness();
    await h.module.join(SESSION);
    // Cached state says it is ALICE's turn; BOB moves anyway.
    await h.module.move(SESSION, { type: 'place', cell: 4 });
    expect(h.moveCalls()).toBe(1);
  });

  it('leaves the cached board untouched when the move is rejected (Req 6.11)', async () => {
    const rejected = {
      ok: false as const,
      error: {
        code: ERROR_CODES.INVALID_MOVE,
        message: 'Cell is already occupied',
        details: { gameState: board([ALICE, ...Array(8).fill(null)]) },
      },
    };
    const h = harness({ move: async () => rejected });
    await h.module.join(SESSION);

    const result = await h.module.move(SESSION, { type: 'place', cell: 0 });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVALID_MOVE);
    expect(h.module.cached(SESSION)?.state).toBe('active');
  });

  it('resynchronises from the state echoed on a rejection (Req 6.11)', async () => {
    // The rejection carries the unchanged authoritative state precisely so a
    // client that had drifted can correct itself, which is the whole reason the
    // Edge Function bothers to echo it.
    const authoritative = board([ALICE, BOB, null, null, null, null, null, null, null]);
    const h = harness({
      move: async () => ({
        ok: false as const,
        error: {
          code: ERROR_CODES.INVALID_MOVE,
          message: 'Cell is already occupied',
          details: { gameState: authoritative },
        },
      }),
    });
    await h.module.join(SESSION);

    await h.module.move(SESSION, { type: 'place', cell: 0 });

    const cached = h.module.cached(SESSION);
    expect((cached?.gameState as { board: unknown[] }).board[1]).toBe(BOB);
  });

  it('does not invent a session when a rejection echoes nothing', async () => {
    const h = harness({ move: async () => refusal(ERROR_CODES.SESSION_NOT_FOUND) });
    await h.module.move(SESSION, { type: 'place', cell: 0 });
    expect(h.module.cached(SESSION)).toBeUndefined();
  });
});

describe('RealTimeGameModule.applyRemoteState', () => {
  it('caches a Broadcast-delivered state (Req 6.4)', () => {
    // The Connection Manager (task 21.3) owns the channel and feeds this; the
    // module owns what happens to the payload once it arrives.
    const h = harness();
    h.module.applyRemoteState(payload({ gameState: board([BOB, ...Array(8).fill(null)]) }));
    const cached = h.module.cached(SESSION);
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(BOB);
  });

  it('notifies a subscriber so the board re-renders', () => {
    const h = harness();
    let notified = 0;
    h.module.subscribe(() => {
      notified += 1;
    });
    h.module.applyRemoteState(payload());
    expect(notified).toBe(1);
  });
});

describe('RealTimeGameModule partial payloads', () => {
  it('keeps fields a partial payload omits (Req 6.7)', async () => {
    // `rt-rejoin` and `rt-presence` use their own narrower `sessionView` that
    // omits `pairingId`, unlike `rt-move`'s. Replacing the cached session
    // wholesale would blank a field the client still needs to scope its
    // subscriptions.
    const h = harness({
      rejoin: async () => ({
        ok: true,
        session: {
          id: SESSION,
          gameId: 'tic-tac-toe',
          state: 'active',
          gameState: board(),
        } as unknown as RTSessionPayload,
      }),
    });
    await h.module.join(SESSION);
    expect(h.module.cached(SESSION)?.pairingId).toBe('pairing-1');

    await h.module.rejoin(SESSION);
    expect(h.module.cached(SESSION)?.pairingId).toBe('pairing-1');
    expect(h.module.cached(SESSION)?.state).toBe('active');
  });
});

describe('RealTimeGameModule.applyRemoteEvent', () => {
  it('applies a full state carried by session_state (Req 6.3)', () => {
    const h = harness();
    h.module.applyRemoteEvent('session_state', {
      ...payload({ state: 'active' }),
      joinedAccounts: [ALICE, BOB],
    } as unknown as Record<string, unknown>);
    expect(h.module.cached(SESSION)?.state).toBe('active');
  });

  it('applies the authoritative board carried by move (Req 6.4)', async () => {
    const h = harness();
    await h.module.join(SESSION);
    h.module.applyRemoteEvent('move', {
      ...payload({ gameState: board([BOB, ...Array(8).fill(null)]) }),
      actor: BOB,
      move: { type: 'place', cell: 0 },
    } as unknown as Record<string, unknown>);
    const cached = h.module.cached(SESSION);
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(BOB);
  });

  it('pauses from an event that carries no session state (Req 6.6)', async () => {
    // `paused` publishes only `{ sessionId, disconnectedPartner, pausedSince,
    // gameState }` — there is no `state` field to read, so the transition has to
    // be inferred from the event name and merged onto the cached session.
    const h = harness();
    await h.module.join(SESSION);
    h.module.applyRemoteEvent('paused', {
      sessionId: SESSION,
      disconnectedPartner: BOB,
      pausedSince: new Date(1_700_000_000_000).toISOString(),
      gameState: board([ALICE, ...Array(8).fill(null)]),
    });

    const cached = h.module.cached(SESSION);
    expect(cached?.state).toBe('paused');
    // The preserved state is what the pause is FOR (Req 6.6).
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(ALICE);
    expect(cached?.pairingId).toBe('pairing-1');
  });

  it('resumes from the preserved state (Req 6.7)', async () => {
    const h = harness();
    await h.module.join(SESSION);
    h.module.applyRemoteEvent('paused', { sessionId: SESSION, gameState: board() });
    h.module.applyRemoteEvent('resumed', {
      sessionId: SESSION,
      rejoinedPartner: BOB,
      gameState: board([ALICE, ...Array(8).fill(null)]),
    });

    const cached = h.module.cached(SESSION);
    expect(cached?.state).toBe('active');
    expect((cached?.gameState as { board: unknown[] }).board[0]).toBe(ALICE);
  });

  it('records the outcome and goes terminal (Req 6.8)', async () => {
    const h = harness();
    await h.module.join(SESSION);
    h.module.applyRemoteEvent('outcome', {
      sessionId: SESSION,
      outcome: { kind: 'completed', winner: ALICE, recordedAt: 1_700_000_000_000 },
      gameState: board(),
    });

    const cached = h.module.cached(SESSION);
    expect(cached?.state).toBe('terminal');
    expect(cached?.outcome).toMatchObject({ kind: 'completed', winner: ALICE });
  });

  it('ignores a transition for a session it has never seen', () => {
    // These events carry no `gameId` or `pairingId`, so there is nothing to
    // build a session from; inventing a half-populated one would be worse than
    // waiting for the next full state.
    const h = harness();
    h.module.applyRemoteEvent('paused', { sessionId: SESSION, gameState: board() });
    expect(h.module.cached(SESSION)).toBeUndefined();
  });

  it('ignores an unrecognized event rather than throwing', () => {
    const h = harness();
    expect(() => h.module.applyRemoteEvent('something_new', { sessionId: SESSION })).not.toThrow();
  });
});

describe('RealTimeGameModule.cached', () => {
  it('reads without touching the network, so the board survives offline (Req 5.1)', async () => {
    const h = harness({
      join: async () => ({ ok: true, session: payload() }),
      move: async () => {
        throw new Error('network is down');
      },
    });
    await h.module.join(SESSION);
    // Offline: the last-known board is still rendered rather than a blank screen.
    expect(h.module.cached(SESSION)?.state).toBe('active');
    expect(h.module.list()).toHaveLength(1);
  });

  it('is empty for an unknown session', () => {
    expect(harness().module.cached(toSessionId('unknown'))).toBeUndefined();
  });
});
