// Feature: ldr-companion-app, Property 24: Asynchronous turn engine correctness
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId } from './common.js';
import type { AccountId } from './common.js';
import type { AsyncGameState, TurnAction } from './game.js';
import { isErr, isOk } from '../result.js';
import { applyTurn } from './async-engine.js';
import type { AsyncEngineState } from './async-engine.js';
import { createBattleshipGame } from './async-battleship.js';
import type { Cell } from './async-battleship.js';
import { createDrawingGame } from './async-drawing.js';

/**
 * Property 24 (task 6.2) — Asynchronous turn engine correctness.
 *
 * For any active asynchronous game session and any attempted turn:
 *  - if the actor is the Active_Turn_Holder and the turn is valid, the turn is
 *    recorded, the game state is updated, and the Active_Turn_Holder transfers
 *    to the other partner (so no partner takes two consecutive turns); and
 *  - if the actor is not the Active_Turn_Holder, or the turn is invalid, the
 *    turn is rejected and the game state and turn holder are left unchanged.
 *
 * The engine is pure, so we can generate a starting state, snapshot it, apply an
 * attempted turn, and assert against the outcome without any I/O. Both concrete
 * rulesets (battleship, drawing) are exercised so the property holds across the
 * game-agnostic engine behaviour rather than one game's rules.
 *
 * Validates: Requirements 7.4, 7.5, 7.7, 7.8
 */

const alice = accountId('alice');
const bob = accountId('bob');
const players: readonly [AccountId, AccountId] = [alice, bob];

const asGame = (s: AsyncEngineState): AsyncGameState =>
  s as unknown as AsyncGameState;
const asEngine = (s: AsyncGameState): AsyncEngineState =>
  s as unknown as AsyncEngineState;

/** A structural snapshot used to assert a rejected turn changed nothing. */
function snapshot(s: AsyncEngineState): string {
  return JSON.stringify({
    activeTurnHolder: s.activeTurnHolder,
    status: s.status,
    winner: s.winner,
    turns: s.turns,
    ruleset: s.ruleset,
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const holderArb: fc.Arbitrary<AccountId> = fc.constantFrom(alice, bob);
/** A generated "actor" that may or may not be the current holder or a stranger. */
const actorArb: fc.Arbitrary<AccountId> = fc.constantFrom(
  alice,
  bob,
  accountId('carol'),
);

const GRID = 4;

const cellArb: fc.Arbitrary<Cell> = fc.record({
  row: fc.integer({ min: 0, max: GRID - 1 }),
  col: fc.integer({ min: 0, max: GRID - 1 }),
});

/** A small, possibly-empty set of distinct ship cells for one partner. */
const shipsArb: fc.Arbitrary<readonly Cell[]> = fc
  .uniqueArray(cellArb, {
    minLength: 0,
    maxLength: 4,
    selector: (c) => `${c.row},${c.col}`,
  })
  .map((cells) => cells);

/** A generated Battleship starting state with random ship placements + holder. */
const battleshipStateArb: fc.Arbitrary<AsyncEngineState> = fc
  .record({
    aliceShips: shipsArb,
    bobShips: shipsArb,
    firstHolder: holderArb,
  })
  .map(({ aliceShips, bobShips, firstHolder }) =>
    createBattleshipGame({
      players,
      firstHolder,
      size: GRID,
      ships: { [alice]: aliceShips, [bob]: bobShips },
    }),
  );

/** A generated drawing-game starting state, capped or open-ended. */
const drawingStateArb: fc.Arbitrary<AsyncEngineState> = fc
  .record({
    firstHolder: holderArb,
    maxRounds: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  })
  .map(({ firstHolder, maxRounds }) =>
    maxRounds === undefined
      ? createDrawingGame({ players, firstHolder })
      : createDrawingGame({ players, firstHolder, maxRounds }),
  );

/** A battleship action: mostly on-grid, occasionally off-grid / malformed. */
const battleshipActionArb: fc.Arbitrary<TurnAction> = fc.oneof(
  fc
    .record({
      row: fc.integer({ min: 0, max: GRID - 1 }),
      col: fc.integer({ min: 0, max: GRID - 1 }),
    })
    .map((c) => ({ kind: 'battleship.fire', ...c }) as unknown as TurnAction),
  // Off-grid coordinate (invalid).
  fc
    .record({
      row: fc.integer({ min: GRID, max: GRID + 3 }),
      col: fc.integer({ min: 0, max: GRID - 1 }),
    })
    .map((c) => ({ kind: 'battleship.fire', ...c }) as unknown as TurnAction),
  // Wrong action kind for the ruleset (invalid).
  fc.constant({ kind: 'drawing.submit', imageRef: 'x.png' } as unknown as TurnAction),
);

/** A drawing action: mostly valid submits, occasionally blank / wrong-kind. */
const drawingActionArb: fc.Arbitrary<TurnAction> = fc.oneof(
  fc
    .record({
      imageRef: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() !== ''),
      caption: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    })
    .map(
      ({ imageRef, caption }) =>
        ({ kind: 'drawing.submit', imageRef, caption }) as unknown as TurnAction,
    ),
  // Blank image reference (invalid).
  fc.constant({ kind: 'drawing.submit', imageRef: '   ' } as unknown as TurnAction),
  // Wrong action kind for the ruleset (invalid).
  fc.constant({ kind: 'battleship.fire', row: 0, col: 0 } as unknown as TurnAction),
);

/** A (state, actor, action) attempt spanning both rulesets. */
const attemptArb = fc.oneof(
  fc.record({
    state: battleshipStateArb,
    actor: actorArb,
    action: battleshipActionArb,
  }),
  fc.record({
    state: drawingStateArb,
    actor: actorArb,
    action: drawingActionArb,
  }),
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('applyTurn — asynchronous turn engine correctness (property)', () => {
  // Feature: ldr-companion-app, Property 24: Asynchronous turn engine correctness
  // Validates: Requirements 7.4, 7.5, 7.7, 7.8
  it('records + transfers on a valid holder turn; rejects + preserves otherwise', () => {
    fc.assert(
      fc.property(attemptArb, ({ state, actor, action }) => {
        const before = snapshot(state);
        const opponent = actor === state.players[0] ? state.players[1] : state.players[0];
        const isHolder = actor === state.activeTurnHolder;

        const result = applyTurn(asGame(state), actor, action);

        // The input state must never be mutated (purity), regardless of outcome.
        expect(snapshot(state)).toBe(before);

        if (isOk(result)) {
          // A success is only ever produced for the active turn holder (Req 7.4, 7.7).
          expect(isHolder).toBe(true);

          const next = asEngine(result.value);

          // The turn is recorded at the end of history, attributed to the actor (Req 7.5).
          expect(next.turns).toHaveLength(state.turns.length + 1);
          const recorded = next.turns[next.turns.length - 1];
          expect(recorded?.actor).toBe(actor);
          expect(recorded?.seq).toBe(state.turns.length);
          expect(recorded?.action).toEqual(action);

          // Prior history is preserved unchanged.
          expect(next.turns.slice(0, state.turns.length)).toEqual(state.turns);

          // The Active_Turn_Holder transfers to the other partner, so the same
          // partner cannot take two consecutive turns (Req 7.4). This holds even
          // when the game reaches a terminal state.
          expect(next.activeTurnHolder).toBe(opponent);
          expect(next.activeTurnHolder).not.toBe(actor);

          // The game state advanced: the ruleset state changed.
          expect(next.ruleset).not.toEqual(state.ruleset);

          // Status is either still active or terminal; a terminal result carries
          // a winner that is one of the players or null (draw / non-competitive).
          expect(['active', 'terminal']).toContain(next.status);
          if (next.status === 'terminal') {
            expect(
              next.winner === null ||
                next.winner === state.players[0] ||
                next.winner === state.players[1],
            ).toBe(true);
          }
        } else {
          // A rejection leaves the game state and turn holder unchanged (Req 7.7, 7.8).
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            // A non-holder is rejected as NOT_YOUR_TURN; a holder with an invalid
            // turn is rejected as INVALID_TURN.
            if (!isHolder) {
              expect(result.error.code).toBe('NOT_YOUR_TURN');
            } else {
              expect(result.error.code).toBe('INVALID_TURN');
            }
          }
          // State and holder are untouched (checked via the purity snapshot above).
          expect(snapshot(state)).toBe(before);
        }
      }),
      { numRuns: 200 },
    );
  });
});
