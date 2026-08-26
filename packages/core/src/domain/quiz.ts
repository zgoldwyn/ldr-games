/**
 * Quiz shapes: definitions, questions, sessions, answers, and results
 * (Requirement 8).
 */
import type { AccountId, PairingId, QuestionId, QuizId, SessionId } from './common.js';

/** The two supported question kinds. */
export type QuizQuestionType = 'multiple_choice' | 'short_answer';

/**
 * A recorded answer. A `choice` answer selects one offered option (multiple
 * choice); a `text` answer is free short-answer text (Requirement 8.3).
 */
export type Answer =
  | { readonly kind: 'choice'; readonly value: string }
  | { readonly kind: 'text'; readonly value: string };

/** A themed quiz definition; each question belongs to exactly one quiz (8.9). */
export interface QuizDef {
  readonly id: QuizId;
  readonly theme: string;
  readonly questionIds: readonly QuestionId[];
}

/** A single quiz question belonging to exactly one quiz (Requirement 8.9). */
export interface QuizQuestion {
  readonly id: QuestionId;
  readonly quizId: QuizId;
  readonly type: QuizQuestionType;
  readonly prompt: string;
  /** Present only for multiple-choice questions. */
  readonly choices?: readonly string[];
}

/** The two-phase progression of a quiz session plus its completed state. */
export type QuizPhase = 'self_answer' | 'guessing' | 'complete';

/**
 * A quiz session scoped to a pairing. At most one active session may exist per
 * pairing (Requirements 8.2, 8.11); `phase` gates self-answer visibility via RLS
 * (Requirement 8.4).
 */
export interface QuizSession {
  readonly id: SessionId;
  readonly pairingId: PairingId;
  readonly quizId: QuizId;
  readonly phase: QuizPhase;
  readonly scores: Readonly<Record<AccountId, number>>;
}

/**
 * A partner's self-answer, stored separately so RLS can withhold it from the
 * other partner during the self-answer phase (Requirement 8.4).
 */
export interface QuizSelfAnswer {
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly questionId: QuestionId;
  readonly answer: Answer;
}

/** A partner's guess of the other partner's self-answer (Requirement 8.6). */
export interface QuizGuess {
  readonly sessionId: SessionId;
  readonly accountId: AccountId;
  readonly questionId: QuestionId;
  readonly guess: Answer;
}

/** Per-question breakdown presented when a quiz completes (Requirement 8.8). */
export interface QuizQuestionResult {
  readonly questionId: QuestionId;
  readonly selfAnswers: Readonly<Record<AccountId, Answer>>;
  readonly guesses: Readonly<Record<AccountId, Answer>>;
}

/**
 * Full results of a completed quiz session: each question with both partners'
 * self-answers and guesses, plus each partner's final score (Requirement 8.8).
 */
export interface QuizResults {
  readonly sessionId: SessionId;
  readonly quizId: QuizId;
  readonly questions: readonly QuizQuestionResult[];
  readonly scores: Readonly<Record<AccountId, number>>;
}
