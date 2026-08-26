import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { type AccountId, accountId, gameId, pairingId, sessionId } from './common.js';
import type { GameOutcome, GameState, RTSession, RTSessionState } from './game.js';
import {
  completedOutcome,
  endedWithoutOutcome,
  terminateSession,
} from './rt-session.js';

/**
 * Property 23 (task 5.6) — Real-time terminal outcome is recorded and presented.
 *
 * For any real-time game session driven to a terminal state,
 * {@link terminateSession} records the given {@link GameOutcome}, transitions the
 * session to `terminal`, and preserves the final game state and identity fields.
 * Because there is exactly one authoritative session, the recorded outcome is the
 * single result presented to *both* partners — so the transition being a pure,
 * deterministic function of its inputs is exactly what guarantees both partners
 * observe an identical terminal session and outcome. Terminating an
 * already-terminal session is rejected as an invalid state transition.
 */

// Feature: ldr-companion-app, Property 23: Real-time terminal outcome is recorded and presented

/** A live (non-terminal) session state: any of these may transition to terminal. */
const liveStateArb: fc.Arbitrary<Extract<RTSessionState, 'pending' | 'active' | 'paused'>> =
  fc.constantFrom('pending', 'active', 'paused');

/** An arbitrary game-specific final state (an open record). */
const gameStateArb: fc.Arbitrary<GameState> = fc.dictionary(
  fc.string({ maxLength: 8 }),
  fc.oneof(fc.integer(), fc.string(), fc.boolean()),
  { maxKeys: 6 },
);

/** An arbitrary recorded outcome, built through the module's own constructors. */
function outcomeArb(members: readonly AccountId[]): fc.Arbitrary<GameOutcome> {
  const recordedAt = fc.integer({ min: 0, max: 10_000_000 });
  return fc.oneof(
    // A completed game: winner is one of the partners or null (a draw).
    fc
      .tuple(fc.option(fc.constantFrom(...members), { nil: null }), recordedAt)
      .map(([winner, at]) => completedOutcome(winner, at)),
    // An early termination with no winner (e.g. rejoin window elapsed, Req 6.10).
    recordedAt.map((at) => endedWithoutOutcome(at)),
  );
}

/** Two distinct partner account ids. */
const membersArb: fc.Arbitrary<readonly [AccountId, AccountId]> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 1, maxLength: 12 }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => [accountId(a), accountId(b)] as const);

function makeLiveSession(
  state: 'pending' | 'active' | 'paused',
  gameState: GameState,
  ts: number,
): RTSession {
  const base: RTSession = {
    id: sessionId('s1'),
    pairingId: pairingId('p1'),
    gameId: gameId('battleship'),
    state,
    gameState,
  };
  // Populate the timestamp fields that a real session in this state would carry,
  // so the property also confirms they are cleared on termination.
  if (state === 'pending') return { ...base, pendingSince: ts };
  if (state === 'paused') return { ...base, pausedSince: ts };
  return base;
}

describe('rt-session terminal transition (property)', () => {
  // Validates: Requirements 6.8
  it('records the outcome and preserves state when terminating a live session', () => {
    fc.assert(
      fc.property(
        liveStateArb,
        gameStateArb,
        fc.integer({ min: 0, max: 10_000_000 }),
        membersArb.chain((m) => outcomeArb(m)),
        (state, gameState, ts, outcome) => {
          const session = makeLiveSession(state, gameState, ts);
          const result = terminateSession(session, outcome);

          // Terminating a live session always succeeds.
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;
          const terminal = result.value;

          // Reaches the terminal state (Req 6.8).
          expect(terminal.state).toBe('terminal');

          // The outcome is recorded exactly as provided — this is the single
          // result presented to both partners.
          expect(terminal.outcome).toBeDefined();
          expect(terminal.outcome).toStrictEqual(outcome);

          // The final game state is preserved untouched.
          expect(terminal.gameState).toBe(gameState);
          expect(terminal.gameState).toStrictEqual(gameState);

          // Identity fields carry over unchanged.
          expect(terminal.id).toBe(session.id);
          expect(terminal.pairingId).toBe(session.pairingId);
          expect(terminal.gameId).toBe(session.gameId);

          // The now-irrelevant lifecycle deadlines are cleared.
          expect(terminal.pendingSince).toBeUndefined();
          expect(terminal.pausedSince).toBeUndefined();

          // Determinism: both partners drive the single authoritative session, so
          // re-running the transition yields an identical terminal session.
          const again = terminateSession(session, outcome);
          expect(isOk(again)).toBe(true);
          if (!isOk(again)) return;
          expect(again.value).toStrictEqual(terminal);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 6.8
  it('rejects terminating an already-terminal session, leaving its outcome intact', () => {
    fc.assert(
      fc.property(
        gameStateArb,
        membersArb.chain((m) => outcomeArb(m)),
        membersArb.chain((m) => outcomeArb(m)),
        (gameState, firstOutcome, secondOutcome) => {
          const terminal: RTSession = {
            id: sessionId('s1'),
            pairingId: pairingId('p1'),
            gameId: gameId('battleship'),
            state: 'terminal',
            gameState,
            outcome: firstOutcome,
          };

          const result = terminateSession(terminal, secondOutcome);

          // A second terminate is rejected as an invalid state transition.
          expect(isErr(result)).toBe(true);
          if (!isErr(result)) return;
          expect(result.error.code).toBe(ERROR_CODES.INVALID_SESSION_STATE);

          // The already-recorded outcome is left intact (input is not mutated).
          expect(terminal.outcome).toStrictEqual(firstOutcome);
        },
      ),
      { numRuns: 100 },
    );
  });
});
