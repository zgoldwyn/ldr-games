/**
 * Property suite for pause/rejoin real-time state preservation (Property 21).
 *
 * Exercises the pure transitions in `rt-session.ts`:
 * - `pauseSession` preserves the game state untouched on a disconnect (Req 6.6).
 * - `resumeSession` within the 5-minute window restores exactly that preserved
 *   state, so both partners again see identical state (Req 6.7).
 *
 * The session is server-authoritative: there is a single `gameState`, so
 * "identical for both partners" reduces to "the resumed state deep-equals the
 * state captured at pause". A rejoin *after* the window is rejected without
 * mutating anything, so the preserved state is still intact.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, gameId, pairingId, sessionId } from './common.js';
import type { GameState, RTSession } from './game.js';
import { isErr, isOk } from '../result.js';
import { REJOIN_WINDOW_MS, pauseSession, resumeSession } from './rt-session.js';

// An arbitrary authoritative game state: an open record of JSON-ish values,
// matching `GameState = Record<string, unknown>`.
const gameStateArb: fc.Arbitrary<GameState> = fc
  .object({ maxDepth: 3 })
  .map((o) => o as GameState);

// An arbitrary *active* real-time session (the only state pause accepts).
const activeSessionArb: fc.Arbitrary<RTSession> = fc.record({
  id: fc.string({ minLength: 1 }).map(sessionId),
  pairingId: fc.string({ minLength: 1 }).map(pairingId),
  gameId: fc.string({ minLength: 1 }).map(gameId),
  gameState: gameStateArb,
});

describe('Property 21: Pause preserves and rejoin restores real-time state', () => {
  // Feature: ldr-companion-app, Property 21: Pause preserves and rejoin restores real-time state
  it('pause preserves the game state and rejoin within 5 minutes restores exactly that state (Req 6.6, 6.7)', () => {
    fc.assert(
      fc.property(
        activeSessionArb,
        fc.integer({ min: 0, max: 2 ** 40 }), // pause time
        fc.integer({ min: 0, max: REJOIN_WINDOW_MS }), // rejoin delay within window
        (base, pausedAt, rejoinDelay) => {
          const active: RTSession = { ...base, state: 'active' };
          // Snapshot the pre-pause state to prove it is never mutated.
          const stateAtPause = structuredClone(active.gameState);

          // --- Pause (Req 6.6): state is preserved untouched. ---
          const paused = pauseSession(active, pausedAt);
          expect(isOk(paused)).toBe(true);
          if (!isOk(paused)) return;
          expect(paused.value.state).toBe('paused');
          expect(paused.value.pausedSince).toBe(pausedAt);
          // The preserved game state equals the state at the moment of pause.
          expect(paused.value.gameState).toEqual(stateAtPause);
          // Purity: pausing did not mutate the original active session.
          expect(active.gameState).toEqual(stateAtPause);

          // --- Rejoin within 5 minutes (Req 6.7): restore exactly that state. ---
          const resumed = resumeSession(paused.value, pausedAt + rejoinDelay);
          expect(isOk(resumed)).toBe(true);
          if (!isOk(resumed)) return;
          expect(resumed.value.state).toBe('active');
          // Both partners see identical state: the single authoritative
          // gameState is exactly the state captured at pause.
          expect(resumed.value.gameState).toEqual(stateAtPause);
          // The pause deadline is cleared once resumed.
          expect(resumed.value.pausedSince).toBeUndefined();
        },
      ),
    );
  });

  // Feature: ldr-companion-app, Property 21: Pause preserves and rejoin restores real-time state
  it('a rejoin after the 5-minute window is rejected and leaves the preserved state intact (Req 6.7)', () => {
    fc.assert(
      fc.property(
        activeSessionArb,
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 1, max: 24 * 60 * 60 * 1000 }), // strictly past the window
        (base, pausedAt, overBy) => {
          const active: RTSession = { ...base, state: 'active' };
          const stateAtPause = structuredClone(active.gameState);

          const paused = pauseSession(active, pausedAt);
          expect(isOk(paused)).toBe(true);
          if (!isOk(paused)) return;

          const resumed = resumeSession(paused.value, pausedAt + REJOIN_WINDOW_MS + overBy);
          expect(isErr(resumed)).toBe(true);
          if (!isErr(resumed)) return;
          expect(resumed.error.code).toBe('REJOIN_WINDOW_EXPIRED');
          // The paused session (and its preserved state) is untouched by the
          // rejected rejoin.
          expect(paused.value.state).toBe('paused');
          expect(paused.value.gameState).toEqual(stateAtPause);
        },
      ),
    );
  });
});
