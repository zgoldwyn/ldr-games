// Feature: ldr-companion-app, Property 41: Turn hand-off notification
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, gameId, notificationId, sessionId } from './common.js';
import type { AccountId, Timestamp } from './common.js';
import type { AsyncGameState, AsyncSession, TurnAction } from './game.js';
import { isOk } from '../result.js';
import { applyTurn } from './async-engine.js';
import type { AsyncEngineState } from './async-engine.js';
import { createBattleshipGame } from './async-battleship.js';
import type { Cell } from './async-battleship.js';
import { createDrawingGame } from './async-drawing.js';
import {
  type AsyncTurnNotificationPayload,
  deriveTurnHandoffNotification,
} from './async-lifecycle.js';

/**
 * Property 41 (task 6.5) — Turn hand-off notification.
 *
 * For any valid turn completed in an active asynchronous game session, a
 * your-turn notification is produced for the partner who becomes the new
 * Active_Turn_Holder (Requirement 7.6).
 *
 * The test drives a real, valid turn through the pure engine (`applyTurn`) so
 * the "valid turn completed" precondition is genuine rather than assumed: only
 * when the engine reports success — meaning ownership has transferred — do we
 * derive the hand-off notification against the post-turn session. We then assert
 * the notification targets exactly the new holder (the former actor's opponent),
 * carries the `your_turn` async-turn payload, and is always produced. Both
 * concrete rulesets (battleship, drawing) are exercised so the property holds
 * across the game-agnostic engine rather than one game's rules.
 *
 * Validates: Requirements 7.6
 */

const alice = accountId('alice');
const bob = accountId('bob');
const players: readonly [AccountId, AccountId] = [alice, bob];

const asGame = (s: AsyncEngineState): AsyncGameState =>
  s as unknown as AsyncGameState;
const asEngine = (s: AsyncGameState): AsyncEngineState =>
  s as unknown as AsyncEngineState;

// ---------------------------------------------------------------------------
// Generators — a starting state plus a *valid* turn for the current holder
// ---------------------------------------------------------------------------

const holderArb: fc.Arbitrary<AccountId> = fc.constantFrom(alice, bob);

const GRID = 4;

const cellArb: fc.Arbitrary<Cell> = fc.record({
  row: fc.integer({ min: 0, max: GRID - 1 }),
  col: fc.integer({ min: 0, max: GRID - 1 }),
});

const shipsArb: fc.Arbitrary<readonly Cell[]> = fc.uniqueArray(cellArb, {
  minLength: 0,
  maxLength: 4,
  selector: (c) => `${c.row},${c.col}`,
});

/** A battleship start state paired with an on-grid fire (a valid holder turn). */
const battleshipAttemptArb = fc
  .record({
    aliceShips: shipsArb,
    bobShips: shipsArb,
    firstHolder: holderArb,
    row: fc.integer({ min: 0, max: GRID - 1 }),
    col: fc.integer({ min: 0, max: GRID - 1 }),
  })
  .map(({ aliceShips, bobShips, firstHolder, row, col }) => ({
    state: createBattleshipGame({
      players,
      firstHolder,
      size: GRID,
      ships: { [alice]: aliceShips, [bob]: bobShips },
    }),
    action: { kind: 'battleship.fire', row, col } as unknown as TurnAction,
  }));

/** A drawing start state paired with a non-empty submit (a valid holder turn). */
const drawingAttemptArb = fc
  .record({
    firstHolder: holderArb,
    maxRounds: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
    imageRef: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() !== ''),
    caption: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  })
  .map(({ firstHolder, maxRounds, imageRef, caption }) => ({
    state:
      maxRounds === undefined
        ? createDrawingGame({ players, firstHolder })
        : createDrawingGame({ players, firstHolder, maxRounds }),
    action: { kind: 'drawing.submit', imageRef, caption } as unknown as TurnAction,
  }));

const attemptArb = fc.oneof(battleshipAttemptArb, drawingAttemptArb);

// Session-envelope fields the hand-off derivation reads that the engine state
// does not carry (the durable row identity + timing live on the session row).
const envelopeArb = fc.record({
  sid: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim() !== ''),
  nid: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim() !== ''),
  turnPendingSince: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  now: fc.integer({ min: 0, max: 4_000_000_000_000 }),
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 41: Turn hand-off notification', () => {
  // Feature: ldr-companion-app, Property 41: Turn hand-off notification
  // Validates: Requirements 7.6
  it('produces a your-turn notification for the partner who becomes the new holder', () => {
    fc.assert(
      fc.property(attemptArb, envelopeArb, ({ state, action }, envelope) => {
        const actor = state.activeTurnHolder;
        const opponent = actor === state.players[0] ? state.players[1] : state.players[0];

        const result = applyTurn(asGame(state), actor, action);

        // Only completed, valid turns exercise the hand-off (Req 7.6). Invalid
        // generated moves (e.g. firing an already-hit cell) are simply skipped;
        // Property 24 already covers rejection behaviour.
        fc.pre(isOk(result));
        if (!isOk(result)) return;

        const next = asEngine(result.value);
        // A completed turn always transfers ownership to the opponent.
        expect(next.activeTurnHolder).toBe(opponent);

        // The post-turn session as the derivation sees it: the engine's new
        // holder plus the durable session-row fields.
        const postTurn: Pick<
          AsyncSession,
          'id' | 'gameId' | 'activeTurnHolder' | 'turnPendingSince'
        > = {
          id: sessionId(envelope.sid),
          gameId: gameId(next.gameId),
          activeTurnHolder: next.activeTurnHolder,
          turnPendingSince: envelope.turnPendingSince as Timestamp,
        };

        const notification = deriveTurnHandoffNotification(
          postTurn,
          envelope.now as Timestamp,
          notificationId(envelope.nid),
        );

        // A notification is always produced for a completed turn (Req 7.6)...
        expect(notification).not.toBeNull();
        // ...targeting exactly the new Active_Turn_Holder, never the actor.
        expect(notification.recipientAccountId).toBe(opponent);
        expect(notification.recipientAccountId).not.toBe(actor);
        // ...as an async-turn "your turn" notification.
        expect(notification.category).toBe('async_turn');
        const payload = notification.payload as AsyncTurnNotificationPayload;
        expect(payload.kind).toBe('your_turn');
        expect(payload.sessionId).toBe(postTurn.id);
        expect(payload.gameId).toBe(postTurn.gameId);
        // The notification is fresh (unacknowledged, undelivered) and stamped now.
        expect(notification.createdAt).toBe(envelope.now);
        expect(notification.acknowledgedAt).toBeNull();
        expect(notification.deliveredAt).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
