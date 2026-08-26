import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { accountId, quizId, questionId, sessionId, pairingId } from './common.js';
import type { AccountId } from './common.js';
import type { Answer, QuizQuestion, QuizQuestionType } from './quiz.js';
import { answersMatch, scoreSession } from './quiz-scoring.js';
import {
  createQuizSession,
  recordGuess,
  recordSelfAnswer,
  type QuizSessionState,
} from './quiz-session.js';
import { isOk } from '../result.js';

// Feature: ldr-companion-app, Property 31: Quiz scoring matches per answer type
//
// For any quiz question, self-answer, and guess, the guess awards exactly one
// point if and only if it matches the self-answer under the type's matching
// rule — an identical selected choice for a multiple-choice question, or text
// equal after trimming leading/trailing whitespace and case-insensitive
// comparison for a short-answer question — and a partner's total score equals
// the count of that partner's matching guesses.
//
// The test derives an INDEPENDENT matching oracle straight from the acceptance
// criteria (Requirement 8.7) and asserts that (a) `answersMatch` agrees with
// the oracle for every question type / answer-kind combination, and (b) after a
// full session is played out through `recordSelfAnswer` / `recordGuess`, each
// partner's projected score (via `scoreSession`) equals the count of that
// partner's guesses the oracle deems matching.
//
// Validates: Requirements 8.7

// ---------------------------------------------------------------------------
// Independent matching oracle (derived from Requirement 8.7, not the impl)
// ---------------------------------------------------------------------------

/** Normalize short-answer text: strip surrounding whitespace, fold case. */
const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * The expected match result under the type's rule, computed independently of
 * the module under test. A guess only matches when both answers carry the kind
 * that corresponds to the question type.
 */
function expectedMatch(type: QuizQuestionType, self: Answer, guess: Answer): boolean {
  if (type === 'multiple_choice') {
    return self.kind === 'choice' && guess.kind === 'choice' && self.value === guess.value;
  }
  // short_answer
  return (
    self.kind === 'text' &&
    guess.kind === 'text' &&
    normalize(self.value) === normalize(guess.value)
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const CHOICES = ['red', 'green', 'blue', 'yellow'] as const;

/** A small pool of base words so text answers collide often enough to matter. */
const BASE_WORDS = ['yes', 'no', 'blue', 'pizza', 'cat', 'hello world'] as const;

/** Whitespace padding of up to three surrounding blank characters. */
const padding = fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 3 });

/**
 * A short-answer text value: a base word with random surrounding whitespace and
 * random casing, so trimming and case-folding are genuinely exercised while
 * matches still occur across independently generated values.
 */
const textValue = fc
  .tuple(padding, fc.constantFrom(...BASE_WORDS), padding, fc.boolean())
  .map(([lead, word, trail, upper]) => `${lead}${upper ? word.toUpperCase() : word}${trail}`);

const choiceAnswer: fc.Arbitrary<Answer> = fc
  .constantFrom(...CHOICES)
  .map((value) => ({ kind: 'choice', value }));

const textAnswer: fc.Arbitrary<Answer> = textValue.map((value) => ({ kind: 'text', value }));

/** Any answer regardless of kind — used to probe the kind-mismatch clause. */
const anyAnswer: fc.Arbitrary<Answer> = fc.oneof(choiceAnswer, textAnswer);

const questionType: fc.Arbitrary<QuizQuestionType> = fc.constantFrom(
  'multiple_choice',
  'short_answer',
);

/** A valid answer for a question of the given type (so it will be recorded). */
const validAnswerFor = (type: QuizQuestionType): fc.Arbitrary<Answer> =>
  type === 'multiple_choice' ? choiceAnswer : textAnswer;

// ---------------------------------------------------------------------------
// Property 31a: per-answer-type matching rule
// ---------------------------------------------------------------------------

describe('answersMatch (Property 31: Quiz scoring matches per answer type)', () => {
  // Feature: ldr-companion-app, Property 31: Quiz scoring matches per answer type
  it('matches iff the type-specific rule holds, for every kind combination', () => {
    fc.assert(
      fc.property(questionType, anyAnswer, anyAnswer, (type, self, guess) => {
        const question: QuizQuestion = {
          id: questionId('q'),
          quizId: quizId('quiz'),
          type,
          prompt: 'p',
          choices: type === 'multiple_choice' ? [...CHOICES] : undefined,
        };
        expect(answersMatch(question, self, guess)).toBe(expectedMatch(type, self, guess));
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 31b: total score equals the count of a partner's matching guesses
// ---------------------------------------------------------------------------

/** Per-question submissions for both partners (all valid for the type). */
interface QuestionPlan {
  readonly type: QuizQuestionType;
  readonly selfA: Answer;
  readonly selfB: Answer;
  readonly guessA: Answer;
  readonly guessB: Answer;
}

const questionPlan: fc.Arbitrary<QuestionPlan> = questionType.chain((type) => {
  const a = validAnswerFor(type);
  return fc.record({
    type: fc.constant(type),
    selfA: a,
    selfB: a,
    guessA: a,
    guessB: a,
  });
});

/** Unwrap an ok Result, failing the test loudly on an unexpected error. */
function unwrap(result: ReturnType<typeof recordSelfAnswer>): QuizSessionState {
  if (!isOk(result)) {
    throw new Error(`expected ok transition, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('scoreSession (Property 31: Quiz scoring matches per answer type)', () => {
  // Feature: ldr-companion-app, Property 31: Quiz scoring matches per answer type
  it("each partner's score equals the count of that partner's matching guesses", () => {
    fc.assert(
      fc.property(fc.array(questionPlan, { minLength: 1, maxLength: 5 }), (plans) => {
        // Two distinct partners; sorted ascending so 'acc-a' is partnerA.
        const accA = accountId('acc-a');
        const accB = accountId('acc-b');

        const questions: QuizQuestion[] = plans.map((plan, i) => ({
          id: questionId(`q${i}`),
          quizId: quizId('quiz'),
          type: plan.type,
          prompt: `prompt ${i}`,
          choices: plan.type === 'multiple_choice' ? [...CHOICES] : undefined,
        }));

        let state = createQuizSession({
          id: sessionId('s'),
          pairingId: pairingId('pair'),
          quizId: quizId('quiz'),
          partners: [accA, accB],
        });

        // Self-answer phase: both partners answer every question.
        plans.forEach((plan, i) => {
          state = unwrap(
            recordSelfAnswer(state, questions, {
              accountId: accA,
              questionId: questions[i].id,
              answer: plan.selfA,
            }),
          );
        });
        plans.forEach((plan, i) => {
          state = unwrap(
            recordSelfAnswer(state, questions, {
              accountId: accB,
              questionId: questions[i].id,
              answer: plan.selfB,
            }),
          );
        });

        expect(state.session.phase).toBe('guessing');

        // Guessing phase: each partner guesses the other's self-answer.
        plans.forEach((plan, i) => {
          state = unwrap(
            recordGuess(state, questions, {
              accountId: accA,
              questionId: questions[i].id,
              guess: plan.guessA,
            }),
          );
        });
        plans.forEach((plan, i) => {
          state = unwrap(
            recordGuess(state, questions, {
              accountId: accB,
              questionId: questions[i].id,
              guess: plan.guessB,
            }),
          );
        });

        expect(state.session.phase).toBe('complete');

        // Oracle: a partner scores one point per question whose guess matches
        // the OTHER partner's self-answer (Requirement 8.7).
        const expectedA = plans.filter((p) => expectedMatch(p.type, p.selfB, p.guessA)).length;
        const expectedB = plans.filter((p) => expectedMatch(p.type, p.selfA, p.guessB)).length;

        // Raw score record agrees with the oracle for each partner.
        const scores = state.session.scores as Record<AccountId, number>;
        expect(scores[accA] ?? 0).toBe(expectedA);
        expect(scores[accB] ?? 0).toBe(expectedB);

        // The projected partnerA/partnerB shape (sorted ascending) matches too.
        const projected = scoreSession(state.session);
        expect(projected.partnerA).toBe(expectedA);
        expect(projected.partnerB).toBe(expectedB);
      }),
      { numRuns: 200 },
    );
  });
});
