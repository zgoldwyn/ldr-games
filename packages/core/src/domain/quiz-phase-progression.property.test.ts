// Feature: ldr-companion-app, Property 30: Quiz phase progression
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, pairingId, questionId, quizId, sessionId } from './common.js';
import type { Answer, QuizQuestion } from './quiz.js';
import {
  bothAnsweredAll,
  bothGuessedAll,
  buildQuizResults,
  createQuizSession,
  recordGuess,
  recordSelfAnswer,
  type GuessSubmission,
  type QuizSessionState,
  type SelfAnswerSubmission,
} from './quiz-session.js';

/**
 * Property 30 (task 7.7) — Quiz phase progression.
 *
 * For any quiz session, it transitions from the self-answer phase to the
 * guessing phase *exactly when* both partners have recorded self-answers for
 * all questions, and it transitions to complete *exactly when* both partners
 * have recorded guesses for all questions (Requirements 8.5, 8.8). A completed
 * session's results include every question with both partners' self-answers,
 * both partners' guesses, and each partner's final score (Requirement 8.8).
 *
 * The test drives {@link recordSelfAnswer} / {@link recordGuess} with the full
 * set of 2·N valid submissions (both partners × every question) in a randomized
 * order. Because each submission is distinct and always valid, the "both
 * answered/guessed all" gate flips true on — and only on — the very last
 * submission of each phase, which lets the property assert the "exactly when"
 * boundary after every single step.
 */

const A = accountId('account-a');
const B = accountId('account-b');
const PAIRING = pairingId('pairing-1');
const QUIZ = quizId('quiz-1');
const SESSION = sessionId('session-1');

/** Unwrap a successful Result or fail the property loudly. */
function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * A raw (position-independent) question with valid self-answers and guesses for
 * both partners. The question id is assigned by array position in the property
 * body, so the answer values never depend on the id.
 */
interface RawBundle {
  readonly type: QuizQuestion['type'];
  readonly choices?: readonly string[];
  readonly selfA: Answer;
  readonly selfB: Answer;
  readonly guessA: Answer;
  readonly guessB: Answer;
}

// A multiple-choice question: 2..4 distinct choices, with every answer/guess a
// selection of one of those offered choices (so each submission is valid).
const rawMultipleChoiceArb: fc.Arbitrary<RawBundle> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 4 })
  .chain((choices) => {
    const choiceArb = fc.constantFrom(...choices).map((value): Answer => ({ kind: 'choice', value }));
    return fc.record({
      type: fc.constant<'multiple_choice'>('multiple_choice'),
      choices: fc.constant(choices),
      selfA: choiceArb,
      selfB: choiceArb,
      guessA: choiceArb,
      guessB: choiceArb,
    });
  });

// A short-answer question: every answer/guess is text of 1..50 chars (well
// inside the 1..100 valid range).
const shortTextArb: fc.Arbitrary<Answer> = fc
  .string({ minLength: 1, maxLength: 50 })
  .map((value): Answer => ({ kind: 'text', value }));

const rawShortAnswerArb: fc.Arbitrary<RawBundle> = fc.record({
  type: fc.constant<'short_answer'>('short_answer'),
  selfA: shortTextArb,
  selfB: shortTextArb,
  guessA: shortTextArb,
  guessB: shortTextArb,
});

const rawBundleArb: fc.Arbitrary<RawBundle> = fc.oneof(rawMultipleChoiceArb, rawShortAnswerArb);

/** A bundle bound to a concrete question (id assigned by position). */
interface QuestionBundle extends RawBundle {
  readonly question: QuizQuestion;
}

/** Build a concrete question (with id `q{index}`) from a raw bundle. */
function bindBundle(raw: RawBundle, index: number): QuestionBundle {
  const id = questionId(`q${index}`);
  const question: QuizQuestion =
    raw.type === 'multiple_choice'
      ? { id, quizId: QUIZ, type: 'multiple_choice', prompt: `prompt-${index}`, choices: raw.choices ?? [] }
      : { id, quizId: QUIZ, type: 'short_answer', prompt: `prompt-${index}` };
  return { ...raw, question };
}

/** Reorder `items` by a parallel array of sort keys (stable, valid permutation). */
function reorderByKeys<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i] }))
    .sort((x, y) => x.key - y.key)
    .map((entry) => entry.item);
}

// The scenario: 1..5 questions plus randomized submission orders for the
// self-answer and guessing phases (2·N distinct submissions each).
const scenarioArb = fc.array(rawBundleArb, { minLength: 1, maxLength: 5 }).chain((raws) => {
  const submissionCount = raws.length * 2;
  const keysArb = fc.array(fc.integer(), { minLength: submissionCount, maxLength: submissionCount });
  return fc.record({
    raws: fc.constant(raws),
    selfKeys: keysArb,
    guessKeys: keysArb,
  });
});

describe('quiz-session: phase progression (property)', () => {
  // Feature: ldr-companion-app, Property 30: Quiz phase progression
  // Validates: Requirements 8.5, 8.8
  it('transitions self_answer→guessing→complete exactly when both partners finish each phase', () => {
    fc.assert(
      fc.property(scenarioArb, ({ raws, selfKeys, guessKeys }) => {
        const bundles = raws.map(bindBundle);
        const questions = bundles.map((b) => b.question);
        const questionIds = questions.map((q) => q.id);

        // Canonical submission order: for each question, partner A then B.
        const selfSubs: SelfAnswerSubmission[] = [];
        const guessSubs: GuessSubmission[] = [];
        for (const b of bundles) {
          selfSubs.push({ accountId: A, questionId: b.question.id, answer: b.selfA });
          selfSubs.push({ accountId: B, questionId: b.question.id, answer: b.selfB });
          guessSubs.push({ accountId: A, questionId: b.question.id, guess: b.guessA });
          guessSubs.push({ accountId: B, questionId: b.question.id, guess: b.guessB });
        }
        const orderedSelf = reorderByKeys(selfSubs, selfKeys);
        const orderedGuess = reorderByKeys(guessSubs, guessKeys);

        let state: QuizSessionState = createQuizSession({
          id: SESSION,
          pairingId: PAIRING,
          quizId: QUIZ,
          partners: [A, B],
        });
        expect(state.session.phase).toBe('self_answer');

        // Self-answer phase: stays in self_answer until the final submission,
        // which is exactly when both partners have answered every question (8.5).
        orderedSelf.forEach((sub, i) => {
          state = expectOk(recordSelfAnswer(state, questions, sub));
          const finished = bothAnsweredAll(state, questionIds);
          const isLast = i === orderedSelf.length - 1;
          expect(finished).toBe(isLast);
          expect(state.session.phase).toBe(finished ? 'guessing' : 'self_answer');
        });
        expect(state.session.phase).toBe('guessing');

        // Guessing phase: stays in guessing until the final submission, which is
        // exactly when both partners have guessed every question (8.8).
        orderedGuess.forEach((sub, i) => {
          state = expectOk(recordGuess(state, questions, sub));
          const finished = bothGuessedAll(state, questionIds);
          const isLast = i === orderedGuess.length - 1;
          expect(finished).toBe(isLast);
          expect(state.session.phase).toBe(finished ? 'complete' : 'guessing');
        });
        expect(state.session.phase).toBe('complete');

        // Completed results carry every question with both partners' self-answers,
        // both partners' guesses, and each partner's final score (8.8).
        const results = buildQuizResults(state, questions);
        expect(results.questions).toHaveLength(questions.length);
        for (const b of bundles) {
          const qr = results.questions.find((r) => r.questionId === b.question.id);
          expect(qr).toBeDefined();
          expect(qr!.selfAnswers[A]).toEqual(b.selfA);
          expect(qr!.selfAnswers[B]).toEqual(b.selfB);
          expect(qr!.guesses[A]).toEqual(b.guessA);
          expect(qr!.guesses[B]).toEqual(b.guessB);
        }
        expect(results.scores).toEqual(state.session.scores);
        expect(typeof results.scores[A]).toBe('number');
        expect(typeof results.scores[B]).toBe('number');
      }),
      { numRuns: 100 },
    );
  });
});
