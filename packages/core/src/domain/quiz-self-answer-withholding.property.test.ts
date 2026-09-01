// Feature: ldr-companion-app, Property 28: Quiz self-answers are withheld during the self-answer phase
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  accountId,
  pairingId,
  questionId,
  quizId,
  sessionId,
  type AccountId,
  type QuestionId,
} from './common.js';
import type { Answer, QuizSelfAnswer, QuizSession } from './quiz.js';
import { buildQuizSessionView, type QuizSessionState } from './quiz-session.js';

/**
 * Property 28 (task 7.8) — Quiz self-answers are withheld during the
 * self-answer phase (Requirement 8.4).
 *
 * *For any* quiz session in the self-answer phase, the serialized view built for
 * one partner (the pure logic behind the self-answer-withholding RLS policy)
 * never contains the other partner's self-answers — the viewer sees only their
 * own recorded self-answers, and every withheld answer belongs to the other
 * partner.
 *
 * The generator constructs self-answer-phase states directly (rather than via
 * the transition functions) so it can freely explore partially- and
 * fully-populated self-answer sets from either or both partners while pinning
 * the phase to `self_answer`, which is exactly the situation the property
 * quantifies over.
 */

const A = accountId('account-a');
const B = accountId('account-b');
const PARTNERS: readonly AccountId[] = [A, B];
const SESSION = sessionId('session-1');
const PAIRING = pairingId('pairing-1');
const QUIZ = quizId('quiz-1');

/** An `Answer` (a multiple-choice selection or free short-answer text). */
const answerArb: fc.Arbitrary<Answer> = fc.oneof(
  fc.record({
    kind: fc.constant<'choice'>('choice'),
    value: fc.constantFrom('red', 'blue', 'green'),
  }),
  fc.record({
    kind: fc.constant<'text'>('text'),
    value: fc.string({ minLength: 1, maxLength: 20 }),
  }),
);

/** A distinct set of question ids for the session (q0, q1, ...). */
const questionIdsArb: fc.Arbitrary<readonly QuestionId[]> = fc
  .integer({ min: 1, max: 6 })
  .map((n) => Array.from({ length: n }, (_, i) => questionId(`q${i}`)));

/**
 * A quiz-session state pinned to the `self_answer` phase, with an arbitrary
 * subset of (partner, question) self-answers recorded. No guesses exist in the
 * self-answer phase.
 */
const selfAnswerPhaseStateArb: fc.Arbitrary<QuizSessionState> = questionIdsArb.chain(
  (questionIds) => {
    // For each (partner, question), independently decide whether an answer was
    // recorded, and if so, what it is.
    const cellArb = fc.option(answerArb, { nil: undefined });
    const gridArb = fc.array(fc.array(cellArb, { minLength: questionIds.length, maxLength: questionIds.length }), {
      minLength: PARTNERS.length,
      maxLength: PARTNERS.length,
    });
    return gridArb.map((grid) => {
      const selfAnswers: QuizSelfAnswer[] = [];
      PARTNERS.forEach((partner, pIdx) => {
        questionIds.forEach((qid, qIdx) => {
          const answer = grid[pIdx][qIdx];
          if (answer !== undefined) {
            selfAnswers.push({ sessionId: SESSION, accountId: partner, questionId: qid, answer });
          }
        });
      });
      const session: QuizSession = {
        id: SESSION,
        pairingId: PAIRING,
        quizId: QUIZ,
        phase: 'self_answer',
        scores: { [A]: 0, [B]: 0 } as Record<AccountId, number>,
      };
      return { session, selfAnswers, guesses: [] };
    });
  },
);

describe('quiz self-answer withholding (property)', () => {
  // Feature: ldr-companion-app, Property 28: Quiz self-answers are withheld during the self-answer phase
  // Validates: Requirements 8.4
  it('never exposes the other partner self-answers in the self-answer phase view', () => {
    fc.assert(
      fc.property(selfAnswerPhaseStateArb, fc.constantFrom(A, B), (state, viewer) => {
        const other = viewer === A ? B : A;
        const view = buildQuizSessionView(state, viewer);

        // The view never contains any of the other partner's self-answers.
        expect(view.selfAnswers.some((sa) => sa.accountId === other)).toBe(false);

        // Every self-answer in the view belongs to the viewer.
        expect(view.selfAnswers.every((sa) => sa.accountId === viewer)).toBe(true);

        // The viewer still sees exactly their own recorded self-answers — none
        // are dropped, so withholding is scoped to the other partner only.
        const ownAnswers = state.selfAnswers.filter((sa) => sa.accountId === viewer);
        expect(view.selfAnswers).toEqual(ownAnswers);
      }),
      { numRuns: 100 },
    );
  });
});
