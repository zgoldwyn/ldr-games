import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, pairingId, quizId, sessionId } from './common.js';
import type { AccountId } from './common.js';
import { createQuizSession } from './quiz-session.js';

/**
 * Property 26: Quiz session initial state (Req 8.2).
 *
 * For any quiz started for a pairing with no active quiz session, the created
 * session is in the `self_answer` phase with no recorded self-answers, no
 * recorded guesses, and a score of zero for each partner. This exercises the
 * pure initializer {@link createQuizSession} across arbitrary session, pairing,
 * quiz, and (distinct) partner identifiers.
 *
 * **Validates: Requirements 8.2**
 */
describe('Property 26: Quiz session initial state', () => {
  // Feature: ldr-companion-app, Property 26: Quiz session initial state
  it('starts in self-answer phase with no answers, no guesses, and zero score per partner', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        // Two partners; constrain to distinct raw strings so the pairing has two
        // members (a real pairing never pairs an account with itself).
        fc
          .tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }))
          .filter(([a, b]) => a !== b),
        (rawSession, rawPairing, rawQuiz, [rawA, rawB]) => {
          const a: AccountId = accountId(rawA);
          const b: AccountId = accountId(rawB);

          const state = createQuizSession({
            id: sessionId(rawSession),
            pairingId: pairingId(rawPairing),
            quizId: quizId(rawQuiz),
            partners: [a, b],
          });

          // Phase is the initial self-answer phase.
          expect(state.session.phase).toBe('self_answer');

          // No recorded self-answers and no recorded guesses.
          expect(state.selfAnswers).toEqual([]);
          expect(state.guesses).toEqual([]);

          // Exactly the two partners, each with a score of zero.
          expect(state.session.scores).toEqual({ [a]: 0, [b]: 0 });
          expect(Object.keys(state.session.scores).sort()).toEqual([rawA, rawB].sort());
          for (const partner of [a, b]) {
            expect(state.session.scores[partner]).toBe(0);
          }

          // Identity fields are threaded through unchanged.
          expect(state.session.id).toBe(rawSession);
          expect(state.session.pairingId).toBe(rawPairing);
          expect(state.session.quizId).toBe(rawQuiz);
        },
      ),
      { numRuns: 200 },
    );
  });
});
