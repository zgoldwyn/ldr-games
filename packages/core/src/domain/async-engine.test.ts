/**
 * Unit tests for the pure asynchronous turn engine (Requirements 7.4, 7.5, 7.7,
 * 7.8). These cover specific example turns and edge cases; the universal
 * property (Property 24) is exercised separately by the property suite.
 */
import { describe, expect, it } from 'vitest';
import { accountId } from './common.js';
import type { AccountId } from './common.js';
import type { AsyncGameState, TurnAction } from './game.js';
import { isErr, isOk } from '../result.js';
import { applyTurn } from './async-engine.js';
import type { AsyncEngineState } from './async-engine.js';
import { createBattleshipGame } from './async-battleship.js';
import { createDrawingGame } from './async-drawing.js';

const alice = accountId('alice');
const bob = accountId('bob');

const asGame = (s: AsyncEngineState): AsyncGameState =>
  s as unknown as AsyncGameState;
const asEngine = (s: AsyncGameState): AsyncEngineState =>
  s as unknown as AsyncEngineState;

const fire = (row: number, col: number): TurnAction =>
  ({ kind: 'battleship.fire', row, col }) as unknown as TurnAction;
const submit = (imageRef: string, caption?: string): TurnAction =>
  ({ kind: 'drawing.submit', imageRef, caption }) as unknown as TurnAction;

// A tiny battleship game: Bob's only ship is at (0,0); Alice fires first.
function battleship(firstHolder: AccountId = alice): AsyncEngineState {
  return createBattleshipGame({
    players: [alice, bob],
    firstHolder,
    size: 3,
    ships: {
      [alice]: [{ row: 2, col: 2 }],
      [bob]: [{ row: 0, col: 0 }],
    },
  });
}

describe('applyTurn — holder authorization', () => {
  it('rejects a non-holder with NOT_YOUR_TURN and leaves state unchanged (Req 7.7)', () => {
    const state = asGame(battleship(alice));
    const result = applyTurn(state, bob, fire(1, 1));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('NOT_YOUR_TURN');
    // Same reference / value returned unchanged.
    expect(state).toBe(state);
    expect(asEngine(state).activeTurnHolder).toBe(alice);
    expect(asEngine(state).turns).toHaveLength(0);
  });

  it('rejects a turn on a terminal session with INVALID_TURN', () => {
    const start = battleship(alice);
    const terminal: AsyncEngineState = { ...start, status: 'terminal' };
    const result = applyTurn(asGame(terminal), alice, fire(0, 0));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVALID_TURN');
  });
});

describe('applyTurn — battleship rules', () => {
  it('records a valid miss and transfers the holder to the partner (Req 7.4, 7.5)', () => {
    const state = asGame(battleship(alice));
    const result = applyTurn(state, alice, fire(1, 1));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const next = asEngine(result.value);

    expect(next.activeTurnHolder).toBe(bob);
    expect(next.status).toBe('active');
    expect(next.turns).toHaveLength(1);
    expect(next.turns[0]?.actor).toBe(alice);
    // Original input is not mutated (purity).
    expect(asEngine(state).turns).toHaveLength(0);
    expect(asEngine(state).activeTurnHolder).toBe(alice);
  });

  it('rejects firing at the same coordinate twice with INVALID_TURN (Req 7.8)', () => {
    const first = applyTurn(asGame(battleship(alice)), alice, fire(1, 1));
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    // Hand the turn back to Alice to attempt a duplicate shot.
    const backToAlice: AsyncEngineState = {
      ...asEngine(first.value),
      activeTurnHolder: alice,
    };
    const dup = applyTurn(asGame(backToAlice), alice, fire(1, 1));

    expect(isErr(dup)).toBe(true);
    if (isErr(dup)) expect(dup.error.code).toBe('INVALID_TURN');
  });

  it('rejects an off-grid shot with INVALID_TURN (Req 7.8)', () => {
    const result = applyTurn(asGame(battleship(alice)), alice, fire(5, 5));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVALID_TURN');
  });

  it('reaches a terminal state with a winner when all opponent ships are hit', () => {
    // Bob's only ship is at (0,0); Alice hits it.
    const result = applyTurn(asGame(battleship(alice)), alice, fire(0, 0));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const next = asEngine(result.value);

    expect(next.status).toBe('terminal');
    expect(next.winner).toBe(alice);
  });
});

describe('applyTurn — drawing rules', () => {
  it('appends a drawing and transfers the holder (Req 7.4, 7.5)', () => {
    const state = asGame(createDrawingGame({ players: [alice, bob], firstHolder: alice }));
    const result = applyTurn(state, alice, submit('storage://drawings/1.png', 'hi'));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const next = asEngine(result.value);

    expect(next.activeTurnHolder).toBe(bob);
    expect(next.status).toBe('active');
    expect(next.turns).toHaveLength(1);
  });

  it('rejects a blank image reference with INVALID_TURN (Req 7.8)', () => {
    const state = asGame(createDrawingGame({ players: [alice, bob], firstHolder: alice }));
    const result = applyTurn(state, alice, submit('   '));

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('INVALID_TURN');
  });

  it('terminates a capped gallery once maxRounds drawings are contributed', () => {
    let state = createDrawingGame({ players: [alice, bob], firstHolder: alice, maxRounds: 2 });

    const r1 = applyTurn(asGame(state), alice, submit('a.png'));
    expect(isOk(r1)).toBe(true);
    if (!isOk(r1)) return;
    state = asEngine(r1.value);
    expect(state.status).toBe('active');

    const r2 = applyTurn(asGame(state), bob, submit('b.png'));
    expect(isOk(r2)).toBe(true);
    if (!isOk(r2)) return;
    state = asEngine(r2.value);
    expect(state.status).toBe('terminal');
    expect(state.winner).toBeNull();
  });
});
