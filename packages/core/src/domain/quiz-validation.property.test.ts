// Feature: ldr-companion-app, Property 29: Quiz answer and guess submission validation
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, pairingId, questionId, quizId, sessionId } from './common.js';
import type { Answer, QuizGuess, QuizQuestion, QuizSelfAnswer } from './quiz.js';
import { validateAnswer } from './quiz-scoring.js';
import {
  createQuizSession,
  recordGuess,
  recordSelfAnswer,
  type QuizSessionState,
} from './quiz-session.js';

/**
 * Property 29 (task 7.2) — Quiz answer and guess submission validation.
 *
 * *For any* submission in a quiz session: a valid self-answer to a
 * not-yet-answered question during the self-answer phase is recorded, a valid
 * guess to a not-yet-guessed question during the guessing phase is recorded,
 * and any invalid submission (empty, an unoffered choice, exceeding 100
 * characters, or an answer whose kind does not match the question type) is
 * rejected while any previously recorded value is retained.
 *
 * The generators deliberately exercise the boundaries called out by the task:
 * whitespace-only text (which is valid at length 1..100 — only a literally
 * empty string is rejected) and the inclusive 100-character maximum, plus
 * lengths of 101+ which must be rejected.
 *
 * Validates: Requirements 8.3, 8.6, 8.12, 8.13
 */

const A = accountId('account-a');
const B = accountId('account-b');
const PAIRING = pairingId('pairing-1');
const QUIZ = quizId('quiz-1');
const SESSION = sessionId('session-1');

/** The question whose submissions are under test. */
const TARGET = questionId('q-target');
/** A second, fixed short-answer question used to hold a previously recorded value. */
const OTHER = questionId('q-other');
const OTHER_Q: QuizQuestion = { id: OTHER, quizId: QUIZ, type: 'short_answer', prompt: 'other?' };

/** A valid short-answer used as the pre-existing recorded value. */
const PRIOR_ANSWER: Answer = { kind: 'text', value: 'prior' };

/** Unwrap a successful Result or fail the test loudly. */
function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value;
}

function freshState(): QuizSessionState {
  return createQuizSession({ id: SESSION, pairingId: PAIRING, quizId: QUIZ, partners: [A, B] });
}

// The target question: either multiple-choice (with 1..5 distinct choices) or
// short-answer. `id` is fixed so the surrounding session wiring stays simple.
const targetQuestionArb: fc.Arbitrary<QuizQuestion> = fc.oneof(
  fc
    .uniqueArray(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 5 })
    .map(
      (choices): QuizQuestion => ({
        id: TARGET,
        quizId: QUIZ,
        type: 'multiple_choice',
        prompt: 'pick?',
        choices,
      }),
    ),
  fc.constant<QuizQuestion>({ id: TARGET, quizId: QUIZ, type: 'short_answer', prompt: 'say?' }),
);

/** A submission that IS valid for `q` per Requirements 8.3/8.6. */
function validAnswerArb(q: QuizQuestion): fc.Arbitrary<Answer> {
  if (q.type === 'multiple_choice') {
    // Exactly one of the offered choices.
    return fc.constantFrom(...(q.choices ?? [])).map((value): Answer => ({ kind: 'choice', value }));
  }
  // Short-answer text of length 1..100, exercising whitespace-only strings and
  // the inclusive 100-character upper boundary.
  return fc
    .oneof(
      fc.string({ minLength: 1, maxLength: 100 }),
      fc.integer({ min: 1, max: 100 }).map((n) => ' '.repeat(n)), // whitespace-only
      fc.constant('x'.repeat(100)), // exact 100-char boundary
    )
    .map((value): Answer => ({ kind: 'text', value }));
}

/** A submission that is INVALID for `q` per Requirements 8.12/8.13. */
function invalidAnswerArb(q: QuizQuestion): fc.Arbitrary<Answer> {
  if (q.type === 'multiple_choice') {
    return fc.oneof(
      // A choice that was not offered.
      fc
        .string({ maxLength: 16 })
        .filter((s) => !(q.choices ?? []).includes(s))
        .map((value): Answer => ({ kind: 'choice', value })),
      // Wrong answer kind for the question type.
      fc.string({ minLength: 1, maxLength: 100 }).map((value): Answer => ({ kind: 'text', value })),
    );
  }
  // Short-answer invalids: empty text, text exceeding 100 chars, wrong kind.
  return fc.oneof(
    fc.constant<Answer>({ kind: 'text', value: '' }),
    fc.integer({ min: 101, max: 200 }).map((n): Answer => ({ kind: 'text', value: 'a'.repeat(n) })),
    fc.string({ maxLength: 16 }).map((value): Answer => ({ kind: 'choice', value })),
  );
}

/** Bundle a question with a matched valid and invalid submission for it. */
const submissionBundleArb = targetQuestionArb.chain((q) =>
  fc.record({
    q: fc.constant(q),
    valid: validAnswerArb(q),
    invalid: invalidAnswerArb(q),
  }),
);

describe('Property 29: quiz answer and guess submission validation', () => {
  // Feature: ldr-companion-app, Property 29: Quiz answer and guess submission validation
  // Validates: Requirements 8.3, 8.6, 8.12, 8.13
  it('validateAnswer accepts exactly the valid submissions and rejects the invalid ones', () => {
    fc.assert(
      fc.property(submissionBundleArb, ({ q, valid, invalid }) => {
        expect(validateAnswer(q, valid)).toBe(true);
        expect(validateAnswer(q, invalid)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 29: Quiz answer and guess submission validation
  // Validates: Requirements 8.3, 8.12
  it('records valid self-answers and rejects invalid ones while retaining prior self-answers', () => {
    fc.assert(
      fc.property(submissionBundleArb, ({ q, valid, invalid }) => {
        const questions: readonly QuizQuestion[] = [q, OTHER_Q];

        // Establish a previously recorded self-answer (for a different question)
        // so retention on rejection is observable. Phase stays self_answer
        // because partner B has not answered anything.
        const base = expectOk(
          recordSelfAnswer(freshState(), questions, {
            accountId: A,
            questionId: OTHER,
            answer: PRIOR_ANSWER,
          }),
        );
        expect(base.session.phase).toBe('self_answer');

        // A valid self-answer for the target question is recorded (8.3).
        const accepted = recordSelfAnswer(base, questions, {
          accountId: A,
          questionId: TARGET,
          answer: valid,
        });
        expect(accepted.ok).toBe(true);
        if (accepted.ok) {
          expect(accepted.value.selfAnswers).toHaveLength(2);
          expect(accepted.value.selfAnswers.some((sa) => sa.questionId === TARGET)).toBe(true);
          // The previously recorded self-answer is still present.
          expect(accepted.value.selfAnswers.some((sa) => sa.questionId === OTHER)).toBe(true);
        }

        // An invalid self-answer is rejected and the prior self-answer retained (8.12).
        const rejected = recordSelfAnswer(base, questions, {
          accountId: A,
          questionId: TARGET,
          answer: invalid,
        });
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_ANSWER');
        // No target self-answer leaked in; the prior value remains.
        expect(base.selfAnswers).toHaveLength(1);
        expect(base.selfAnswers[0].questionId).toBe(OTHER);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 29: Quiz answer and guess submission validation
  // Validates: Requirements 8.6, 8.13
  it('records valid guesses and rejects invalid ones while retaining prior guesses', () => {
    fc.assert(
      fc.property(submissionBundleArb, ({ q, valid, invalid }) => {
        const questions: readonly QuizQuestion[] = [q, OTHER_Q];

        // A guessing-phase session that already holds one recorded guess (for a
        // different question). Only partner A has guessed, so completion is not
        // triggered and the phase remains `guessing`.
        const priorGuess: QuizGuess = {
          sessionId: SESSION,
          accountId: A,
          questionId: OTHER,
          guess: PRIOR_ANSWER,
        };
        // Give partner B a self-answer for the target so scoring has something
        // to compare against; it never affects validity.
        const bSelfAnswer: QuizSelfAnswer = {
          sessionId: SESSION,
          accountId: B,
          questionId: TARGET,
          answer: valid,
        };
        const base: QuizSessionState = {
          session: {
            id: SESSION,
            pairingId: PAIRING,
            quizId: QUIZ,
            phase: 'guessing',
            scores: { [A]: 0, [B]: 0 },
          },
          selfAnswers: [bSelfAnswer],
          guesses: [priorGuess],
        };

        // A valid guess for the target question is recorded (8.6).
        const accepted = recordGuess(base, questions, {
          accountId: A,
          questionId: TARGET,
          guess: valid,
        });
        expect(accepted.ok).toBe(true);
        if (accepted.ok) {
          expect(accepted.value.guesses).toHaveLength(2);
          expect(accepted.value.guesses.some((g) => g.questionId === TARGET)).toBe(true);
          // The previously recorded guess is still present.
          expect(accepted.value.guesses.some((g) => g.questionId === OTHER)).toBe(true);
        }

        // An invalid guess is rejected and the prior guess retained (8.13).
        const rejected = recordGuess(base, questions, {
          accountId: A,
          questionId: TARGET,
          guess: invalid,
        });
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_GUESS');
        expect(base.guesses).toHaveLength(1);
        expect(base.guesses[0].questionId).toBe(OTHER);
      }),
      { numRuns: 200 },
    );
  });
});
