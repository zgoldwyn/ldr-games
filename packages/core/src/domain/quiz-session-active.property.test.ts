// Feature: ldr-companion-app, Property 27: Only one active quiz session per pairing
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { pairingId, type PairingId } from './common.js';
import { isErr, isOk } from '../result.js';
import type { QuizSession } from './quiz.js';
import { checkNoActiveQuizSession } from './quiz-session.js';

/**
 * Property 27 (task 7.6) — Only one active quiz session per pairing.
 *
 * `checkNoActiveQuizSession` is the pure guard behind Requirement 8.11: a
 * pairing may have at most one *active* quiz session, where a session is active
 * while it is in the `self_answer` or `guessing` phase and inactive once
 * `complete`. Starting a new session for a pairing that already has an active
 * one must be rejected with `QUIZ_SESSION_IN_PROGRESS` and must leave the
 * existing sessions untouched (the guard is pure and mutates nothing).
 *
 * The generators draw the requesting pairing and the existing sessions' pairings
 * from a small shared pool so that collisions with the requesting pairing occur
 * frequently, exercising both the reject and allow branches.
 */
describe('checkNoActiveQuizSession: one active quiz session per pairing (property)', () => {
  const phaseArb: fc.Arbitrary<QuizSession['phase']> = fc.constantFrom(
    'self_answer',
    'guessing',
    'complete',
  );

  // A small pool of pairing ids so existing sessions frequently share the
  // requesting pairing (and frequently do not).
  const pairingPool: readonly PairingId[] = ['p0', 'p1', 'p2', 'p3'].map(pairingId);
  const pairingArb: fc.Arbitrary<PairingId> = fc.constantFrom(...pairingPool);

  type ExistingSession = Pick<QuizSession, 'pairingId' | 'phase'>;

  const existingSessionArb: fc.Arbitrary<ExistingSession> = fc.record({
    pairingId: pairingArb,
    phase: phaseArb,
  });

  // Feature: ldr-companion-app, Property 27: Only one active quiz session per pairing
  // Validates: Requirements 8.11
  it('rejects a start when an active session exists for the pairing and preserves existing sessions', () => {
    fc.assert(
      fc.property(
        pairingArb,
        fc.array(existingSessionArb, { maxLength: 12 }),
        (requestingPairing, existing) => {
          // Snapshot before the call to prove the guard mutates nothing.
          const snapshot = structuredClone(existing);

          const result = checkNoActiveQuizSession(requestingPairing, existing);

          const hasActive = existing.some(
            (s) => s.pairingId === requestingPairing && s.phase !== 'complete',
          );

          if (hasActive) {
            // Rejected: an active session already exists for this pairing (8.11).
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.error.code).toBe('QUIZ_SESSION_IN_PROGRESS');
            }
          } else {
            // Allowed: no active session for this pairing (complete sessions and
            // sessions for other pairings do not block a new start).
            expect(isOk(result)).toBe(true);
          }

          // The existing sessions are preserved unchanged (8.11).
          expect(existing).toEqual(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });
});
