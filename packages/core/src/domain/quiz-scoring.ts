/**
 * Pure, deterministic quiz helpers: answer validation, answer/guess matching,
 * and score projection (Requirement 8). These are shared verbatim between the
 * client and the scoring Edge Function so both agree on validity and matching.
 *
 * Every function here is a pure function of its inputs with no side effects,
 * making them straightforward to property-test.
 */
import type { AccountId } from './common.js';
import type { Answer, QuizQuestion, QuizSession } from './quiz.js';

/** Inclusive bounds for short-answer text length (Requirements 8.3, 8.12). */
const SHORT_ANSWER_MIN_LENGTH = 1;
const SHORT_ANSWER_MAX_LENGTH = 100;

/**
 * Whether `answer` is a valid submission for question `q`
 * (Requirements 8.3, 8.12, 8.13).
 *
 * - For a multiple-choice question the answer must select exactly one of the
 *   choices offered by the question (a `choice` answer whose value is one of
 *   `q.choices`).
 * - For a short-answer question the answer must be `text` of 1 to 100
 *   characters. Per Requirement 8.12 only a literally empty string is
 *   rejected as empty, so whitespace-only text of length 1..100 is accepted
 *   here (matching still trims and lowercases, see `answersMatch`).
 *
 * An answer whose `kind` does not correspond to the question type is invalid.
 */
export function validateAnswer(q: QuizQuestion, answer: Answer): boolean {
  switch (q.type) {
    case 'multiple_choice':
      return (
        answer.kind === 'choice' &&
        Array.isArray(q.choices) &&
        q.choices.includes(answer.value)
      );
    case 'short_answer':
      return (
        answer.kind === 'text' &&
        answer.value.length >= SHORT_ANSWER_MIN_LENGTH &&
        answer.value.length <= SHORT_ANSWER_MAX_LENGTH
      );
    default:
      return false;
  }
}

/**
 * Whether a guess matches the corresponding self-answer for question `q`
 * (Requirement 8.7).
 *
 * - Multiple-choice: the two answers match when they select the identical
 *   choice.
 * - Short-answer: the two answers match when their text is equal after
 *   trimming leading and trailing whitespace and comparing case-insensitively.
 *
 * Answers whose `kind` does not correspond to the question type never match.
 */
export function answersMatch(q: QuizQuestion, self: Answer, guess: Answer): boolean {
  switch (q.type) {
    case 'multiple_choice':
      return self.kind === 'choice' && guess.kind === 'choice' && self.value === guess.value;
    case 'short_answer':
      return (
        self.kind === 'text' &&
        guess.kind === 'text' &&
        normalizeShortAnswer(self.value) === normalizeShortAnswer(guess.value)
      );
    default:
      return false;
  }
}

/**
 * Project a session's running per-partner tally (one point per matching guess,
 * Requirement 8.7) into a stable two-partner shape.
 *
 * A `QuizSession` records scores keyed by `AccountId`; this helper returns them
 * as `partnerA`/`partnerB`. To stay deterministic regardless of key insertion
 * order, partners are assigned by ascending `AccountId`: the lowest id is
 * `partnerA` and the next is `partnerB`. Absent partners score zero.
 */
export function scoreSession(session: QuizSession): { partnerA: number; partnerB: number } {
  const accounts = (Object.keys(session.scores) as AccountId[]).sort();
  const scoreFor = (account: AccountId | undefined): number =>
    account === undefined ? 0 : session.scores[account] ?? 0;
  return {
    partnerA: scoreFor(accounts[0]),
    partnerB: scoreFor(accounts[1]),
  };
}

/** Trim surrounding whitespace and lowercase for case-insensitive matching. */
function normalizeShortAnswer(value: string): string {
  return value.trim().toLowerCase();
}
