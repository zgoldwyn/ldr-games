/**
 * Client quiz module: catalog reads, server-authoritative submissions, and
 * completed result presentation (Requirement 8).
 *
 * Quiz writes deliberately go only through the `quiz` Edge Function. Its
 * transaction owns duplicate checks, phase changes and score increments. Reads
 * stay on the caller-scoped client: in particular, Postgres RLS withholds a
 * partner's self-answers until the guessing phase, so this module never has a
 * privileged path that could accidentally reveal them early.
 */
import type { QuestionId, QuizId, SessionId } from '../domain/common.js';
import type { QuizError } from '../errors.js';
import type {
  Answer,
  QuizDef,
  QuizGuess,
  QuizResults,
  QuizSelfAnswer,
  QuizSession,
} from '../domain/quiz.js';
import { err, ok, type Result } from '../result.js';

/** A complete readable view of a quiz session at one instant. */
export interface QuizSessionSnapshot {
  readonly session: QuizSession;
  /** RLS may contain only the viewer's rows while phase is `self_answer`. */
  readonly selfAnswers: readonly QuizSelfAnswer[];
  readonly guesses: readonly QuizGuess[];
  /** Present only after the session is complete. */
  readonly results?: QuizResults;
}

/** One successful answer from the quiz Edge Function. */
export type QuizMutationOutcome =
  | { readonly ok: true; readonly snapshot: QuizSessionSnapshot }
  | { readonly ok: false; readonly error: QuizError };

/** Narrow collaborators so lifecycle behavior is unit-testable without a stack. */
export interface QuizPorts {
  /** Catalog, read through the authenticated caller's RLS scope. */
  readonly listQuizzes: () => Promise<readonly QuizDef[]>;
  /**
   * Session aggregate, read through RLS. `null` covers a missing/inaccessible
   * session and an unavailable read; mutations retain their typed error result.
   */
  readonly fetchSession: (sessionId: SessionId) => Promise<QuizSessionSnapshot | null>;
  /** `quiz { action: 'startSession', quizId }`. */
  readonly startSession: (quizId: QuizId) => Promise<QuizMutationOutcome>;
  /** `quiz { action: 'submitSelfAnswer', ... }`. */
  readonly submitSelfAnswer: (
    sessionId: SessionId,
    questionId: QuestionId,
    answer: Answer,
  ) => Promise<QuizMutationOutcome>;
  /** `quiz { action: 'submitGuess', ... }`. */
  readonly submitGuess: (
    sessionId: SessionId,
    questionId: QuestionId,
    guess: Answer,
  ) => Promise<QuizMutationOutcome>;
}

export interface QuizModule {
  /** Available themed quizzes for the authenticated caller (Req 8.1). */
  listQuizzes(): Promise<readonly QuizDef[]>;
  /** Open a two-partner, zero-score session through the authoritative function. */
  startSession(quizId: QuizId): Promise<Result<QuizSession, QuizError>>;
  /** Record the caller's own answer through the authoritative function. */
  submitSelfAnswer(
    sessionId: SessionId,
    questionId: QuestionId,
    answer: Answer,
  ): Promise<Result<QuizSession, QuizError>>;
  /** Record the caller's guess through the authoritative function. */
  submitGuess(
    sessionId: SessionId,
    questionId: QuestionId,
    guess: Answer,
  ): Promise<Result<QuizSession, QuizError>>;
  /** Reload the RLS-filtered session view; useful after a partner progresses it. */
  refreshSession(sessionId: SessionId): Promise<QuizSessionSnapshot | null>;
  /**
   * Full answers, guesses and scores once completed; `null` while incomplete
   * or when the session is no longer readable.
   */
  getResults(sessionId: SessionId): Promise<QuizResults | null>;
  /** Last session response/read, for immediate rendering without another request. */
  cached(sessionId: SessionId): QuizSessionSnapshot | undefined;
}

/** Build a quiz module over authenticated client ports. */
export function createQuizModule(ports: QuizPorts): QuizModule {
  const cache = new Map<SessionId, QuizSessionSnapshot>();

  function remember(snapshot: QuizSessionSnapshot): QuizSessionSnapshot {
    cache.set(snapshot.session.id, snapshot);
    return snapshot;
  }

  async function mutation(
    call: () => Promise<QuizMutationOutcome>,
  ): Promise<Result<QuizSession, QuizError>> {
    const outcome = await call();
    if (!outcome.ok) return err(outcome.error);
    return ok(remember(outcome.snapshot).session);
  }

  return {
    listQuizzes: () => ports.listQuizzes(),

    startSession: (quizId) => mutation(() => ports.startSession(quizId)),

    submitSelfAnswer: (sessionId, questionId, answer) =>
      mutation(() => ports.submitSelfAnswer(sessionId, questionId, answer)),

    submitGuess: (sessionId, questionId, guess) =>
      mutation(() => ports.submitGuess(sessionId, questionId, guess)),

    async refreshSession(sessionId): Promise<QuizSessionSnapshot | null> {
      const snapshot = await ports.fetchSession(sessionId);
      return snapshot === null ? null : remember(snapshot);
    },

    async getResults(sessionId): Promise<QuizResults | null> {
      // Always re-read: the partner may complete the final guess on another
      // device after our last cached view. The RLS-backed adapter only builds
      // results for a completed session, so no early answer disclosure leaks
      // through this convenience method.
      const snapshot = await ports.fetchSession(sessionId);
      if (snapshot === null) return null;
      remember(snapshot);
      return snapshot.session.phase === 'complete' ? (snapshot.results ?? null) : null;
    },

    cached: (sessionId) => cache.get(sessionId),
  };
}
