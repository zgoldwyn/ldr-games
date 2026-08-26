/**
 * Pure, deterministic quiz-session state machine and supporting validators
 * (Requirement 8). This module owns the *transition* logic that sits on top of
 * the primitive helpers in `quiz-scoring.ts` (`validateAnswer`, `answersMatch`,
 * `scoreSession`), which it reuses rather than reimplements.
 *
 * Everything here is a pure function of its inputs with no I/O, clock reads, or
 * mutation of the arguments, so each transition is fully reproducible and
 * property-testable. These functions are the client + Edge Function agreement
 * on how a quiz session evolves, and `buildQuizSessionView` is the pure logic
 * that backs the self-answer-withholding RLS policy (Requirement 8.4).
 *
 * Data model note: a `QuizSession` (phase + per-partner scores) is stored apart
 * from its `QuizSelfAnswer`s and `QuizGuess`es so RLS can withhold a partner's
 * self-answers during the self-answer phase. The transition functions therefore
 * operate on an aggregate {@link QuizSessionState} that bundles the session row
 * with its self-answers and guesses.
 */
import type { AccountId, PairingId, QuestionId, QuizId, SessionId } from './common.js';
import type {
  Answer,
  QuizDef,
  QuizGuess,
  QuizQuestion,
  QuizQuestionResult,
  QuizResults,
  QuizSelfAnswer,
  QuizSession,
} from './quiz.js';
import { answersMatch, validateAnswer } from './quiz-scoring.js';
import type { QuizError, QuizErrorCode } from '../errors.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';

// ---------------------------------------------------------------------------
// Aggregate session state
// ---------------------------------------------------------------------------

/**
 * The full in-memory state of a quiz session: the session row plus all recorded
 * self-answers and guesses. The transition functions are pure over this shape,
 * returning a new state and never mutating the input.
 */
export interface QuizSessionState {
  readonly session: QuizSession;
  readonly selfAnswers: readonly QuizSelfAnswer[];
  readonly guesses: readonly QuizGuess[];
}

/** A partner's submission of a self-answer for one question. */
export interface SelfAnswerSubmission {
  readonly accountId: AccountId;
  readonly questionId: QuestionId;
  readonly answer: Answer;
}

/** A partner's submission of a guess for one question. */
export interface GuessSubmission {
  readonly accountId: AccountId;
  readonly questionId: QuestionId;
  readonly guess: Answer;
}

/** Build a `QuizError` envelope for a given code. */
function quizErr(code: QuizErrorCode, message: string): QuizError {
  return { code, message };
}

/**
 * The two partners of a session, taken from the score record (which always
 * carries both partners because a session starts with a zero score for each,
 * Requirement 8.2). Returned sorted by ascending `AccountId` for determinism.
 */
export function sessionPartners(session: QuizSession): readonly AccountId[] {
  return (Object.keys(session.scores) as AccountId[]).slice().sort();
}

// ---------------------------------------------------------------------------
// Initial state (Requirement 8.2)
// ---------------------------------------------------------------------------

/** Inputs needed to open a fresh quiz session for a pairing. */
export interface CreateQuizSessionInput {
  readonly id: SessionId;
  readonly pairingId: PairingId;
  readonly quizId: QuizId;
  /** The two partners of the pairing; each starts with a score of zero. */
  readonly partners: readonly [AccountId, AccountId];
}

/**
 * Create the initial state of a quiz session (Requirement 8.2): the session is
 * in the `self_answer` phase with no recorded self-answers, no recorded
 * guesses, and a score of zero for each partner.
 */
export function createQuizSession(input: CreateQuizSessionInput): QuizSessionState {
  const [a, b] = input.partners;
  const scores = { [a]: 0, [b]: 0 } as Record<AccountId, number>;
  return {
    session: {
      id: input.id,
      pairingId: input.pairingId,
      quizId: input.quizId,
      phase: 'self_answer',
      scores,
    },
    selfAnswers: [],
    guesses: [],
  };
}

// ---------------------------------------------------------------------------
// Phase-progression predicates (Requirements 8.5, 8.8)
// ---------------------------------------------------------------------------

/** Whether `account` has recorded a self-answer for every question. */
function partnerAnsweredAll(
  state: QuizSessionState,
  account: AccountId,
  questionIds: readonly QuestionId[],
): boolean {
  return questionIds.every((qid) =>
    state.selfAnswers.some((sa) => sa.accountId === account && sa.questionId === qid),
  );
}

/** Whether `account` has recorded a guess for every question. */
function partnerGuessedAll(
  state: QuizSessionState,
  account: AccountId,
  questionIds: readonly QuestionId[],
): boolean {
  return questionIds.every((qid) =>
    state.guesses.some((g) => g.accountId === account && g.questionId === qid),
  );
}

/**
 * Whether both partners have recorded self-answers for all questions
 * (Requirement 8.5 gate: `self_answer` → `guessing`).
 */
export function bothAnsweredAll(
  state: QuizSessionState,
  questionIds: readonly QuestionId[],
): boolean {
  return sessionPartners(state.session).every((p) =>
    partnerAnsweredAll(state, p, questionIds),
  );
}

/**
 * Whether both partners have recorded guesses for all questions
 * (Requirement 8.8 gate: `guessing` → `complete`).
 */
export function bothGuessedAll(
  state: QuizSessionState,
  questionIds: readonly QuestionId[],
): boolean {
  return sessionPartners(state.session).every((p) =>
    partnerGuessedAll(state, p, questionIds),
  );
}

// ---------------------------------------------------------------------------
// recordSelfAnswer (Requirements 8.3, 8.5, 8.12)
// ---------------------------------------------------------------------------

/**
 * Record a partner's self-answer as a pure transition. On success the returned
 * state has the self-answer appended and, when both partners have now answered
 * every question, the phase advanced to `guessing` (Requirement 8.5). On any
 * rejection the original state is returned unchanged so previously recorded
 * self-answers are retained (Requirement 8.12).
 *
 * Rejections (Requirements 8.12, and phase/lookup guards):
 * - `WRONG_PHASE`      — the session is not in the self-answer phase.
 * - `QUESTION_NOT_FOUND` — the question is not part of this quiz.
 * - `ALREADY_ANSWERED` — the partner already answered this question.
 * - `INVALID_ANSWER`   — the answer fails {@link validateAnswer}.
 */
export function recordSelfAnswer(
  state: QuizSessionState,
  questions: readonly QuizQuestion[],
  submission: SelfAnswerSubmission,
): Result<QuizSessionState, QuizError> {
  if (state.session.phase !== 'self_answer') {
    return err(quizErr('WRONG_PHASE', 'Self-answers may only be recorded in the self-answer phase.'));
  }

  const question = questions.find((q) => q.id === submission.questionId);
  if (question === undefined) {
    return err(quizErr('QUESTION_NOT_FOUND', 'The question does not belong to this quiz.'));
  }

  const alreadyAnswered = state.selfAnswers.some(
    (sa) => sa.accountId === submission.accountId && sa.questionId === submission.questionId,
  );
  if (alreadyAnswered) {
    return err(quizErr('ALREADY_ANSWERED', 'This question has already been answered.'));
  }

  if (!validateAnswer(question, submission.answer)) {
    return err(quizErr('INVALID_ANSWER', 'The self-answer is not valid for this question.'));
  }

  const selfAnswer: QuizSelfAnswer = {
    sessionId: state.session.id,
    accountId: submission.accountId,
    questionId: submission.questionId,
    answer: submission.answer,
  };
  const nextSelfAnswers = [...state.selfAnswers, selfAnswer];
  const questionIds = questions.map((q) => q.id);

  const afterRecord: QuizSessionState = { ...state, selfAnswers: nextSelfAnswers };
  if (bothAnsweredAll(afterRecord, questionIds)) {
    return ok({
      ...afterRecord,
      session: { ...afterRecord.session, phase: 'guessing' },
    });
  }
  return ok(afterRecord);
}

// ---------------------------------------------------------------------------
// recordGuess (Requirements 8.6, 8.7, 8.8, 8.13)
// ---------------------------------------------------------------------------

/**
 * Record a partner's guess as a pure transition. On success the returned state
 * has the guess appended, one point awarded to the guessing partner when the
 * guess matches the *other* partner's recorded self-answer (Requirement 8.7,
 * via {@link answersMatch}), and — when both partners have now guessed every
 * question — the phase advanced to `complete` (Requirement 8.8). On any
 * rejection the original state is returned unchanged so previously recorded
 * guesses are retained (Requirement 8.13).
 *
 * Rejections (Requirement 8.13):
 * - `WRONG_PHASE`        — the session is not in the guessing phase.
 * - `QUESTION_NOT_FOUND` — the question is not part of this quiz.
 * - `ALREADY_GUESSED`    — the partner already guessed this question.
 * - `INVALID_GUESS`      — the guess fails {@link validateAnswer}.
 */
export function recordGuess(
  state: QuizSessionState,
  questions: readonly QuizQuestion[],
  submission: GuessSubmission,
): Result<QuizSessionState, QuizError> {
  if (state.session.phase !== 'guessing') {
    return err(quizErr('WRONG_PHASE', 'Guesses may only be recorded in the guessing phase.'));
  }

  const question = questions.find((q) => q.id === submission.questionId);
  if (question === undefined) {
    return err(quizErr('QUESTION_NOT_FOUND', 'The question does not belong to this quiz.'));
  }

  const alreadyGuessed = state.guesses.some(
    (g) => g.accountId === submission.accountId && g.questionId === submission.questionId,
  );
  if (alreadyGuessed) {
    return err(quizErr('ALREADY_GUESSED', 'This question has already been guessed.'));
  }

  if (!validateAnswer(question, submission.guess)) {
    return err(quizErr('INVALID_GUESS', 'The guess is not valid for this question.'));
  }

  const guess: QuizGuess = {
    sessionId: state.session.id,
    accountId: submission.accountId,
    questionId: submission.questionId,
    guess: submission.guess,
  };
  const nextGuesses = [...state.guesses, guess];

  // Award one point when the guess matches the OTHER partner's self-answer for
  // the same question (Requirement 8.7). The other partner has necessarily
  // answered because the session only reaches the guessing phase once both
  // partners answered every question (Requirement 8.5).
  const otherSelfAnswer = state.selfAnswers.find(
    (sa) => sa.accountId !== submission.accountId && sa.questionId === submission.questionId,
  );
  const isMatch =
    otherSelfAnswer !== undefined && answersMatch(question, otherSelfAnswer.answer, submission.guess);
  const nextScores: Record<AccountId, number> = isMatch
    ? {
        ...state.session.scores,
        [submission.accountId]: (state.session.scores[submission.accountId] ?? 0) + 1,
      }
    : state.session.scores;

  const questionIds = questions.map((q) => q.id);
  const afterRecord: QuizSessionState = {
    ...state,
    guesses: nextGuesses,
    session: { ...state.session, scores: nextScores },
  };
  if (bothGuessedAll(afterRecord, questionIds)) {
    return ok({
      ...afterRecord,
      session: { ...afterRecord.session, phase: 'complete' },
    });
  }
  return ok(afterRecord);
}

// ---------------------------------------------------------------------------
// Results (Requirement 8.8)
// ---------------------------------------------------------------------------

/**
 * Build the full results of a session: each question with both partners'
 * self-answers and guesses, plus each partner's final score (Requirement 8.8).
 * The per-partner scores are the running tally maintained by {@link recordGuess}
 * — the same record that `scoreSession` (from `quiz-scoring.ts`) projects into
 * a `partnerA`/`partnerB` shape for presentation. Questions with no recorded
 * answer/guess for a partner simply omit that partner's entry.
 */
export function buildQuizResults(
  state: QuizSessionState,
  questions: readonly QuizQuestion[],
): QuizResults {
  const questionResults: QuizQuestionResult[] = questions.map((q) => {
    const selfAnswers: Record<AccountId, Answer> = {};
    for (const sa of state.selfAnswers) {
      if (sa.questionId === q.id) selfAnswers[sa.accountId] = sa.answer;
    }
    const guesses: Record<AccountId, Answer> = {};
    for (const g of state.guesses) {
      if (g.questionId === q.id) guesses[g.accountId] = g.guess;
    }
    return { questionId: q.id, selfAnswers, guesses };
  });

  return {
    sessionId: state.session.id,
    quizId: state.session.quizId,
    questions: questionResults,
    scores: { ...state.session.scores },
  };
}

// ---------------------------------------------------------------------------
// One-active-session-per-pairing guard (Requirement 8.11)
// ---------------------------------------------------------------------------

/**
 * A quiz session is "active" while it has not completed — i.e. it is in the
 * `self_answer` or `guessing` phase.
 */
export function isQuizSessionActive(session: Pick<QuizSession, 'phase'>): boolean {
  return session.phase !== 'complete';
}

/**
 * Pure guard enforcing at most one active quiz session per pairing
 * (Requirement 8.11). Given the pairing that wants to start a session and the
 * pairing's existing sessions, this rejects with `QUIZ_SESSION_IN_PROGRESS`
 * when any existing session for that pairing is still active, preserving the
 * existing session by not mutating anything. Otherwise it succeeds.
 */
export function checkNoActiveQuizSession(
  pairingId: PairingId,
  existingSessions: readonly Pick<QuizSession, 'pairingId' | 'phase'>[],
): Result<void, QuizError> {
  const hasActive = existingSessions.some(
    (s) => s.pairingId === pairingId && isQuizSessionActive(s),
  );
  if (hasActive) {
    return err(
      quizErr('QUIZ_SESSION_IN_PROGRESS', 'An active quiz session already exists for this pairing.'),
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Catalog integrity (Requirement 8.9)
// ---------------------------------------------------------------------------

/** A quiz catalog: the quiz definitions and the questions they reference. */
export interface QuizCatalog {
  readonly quizzes: readonly QuizDef[];
  readonly questions: readonly QuizQuestion[];
}

/**
 * A violation of the "each question belongs to exactly one quiz" invariant
 * (Requirement 8.9). `quizIds` is the set of quizzes that claim the question:
 * an empty set means the question is orphaned (belongs to no quiz), and a set
 * of length > 1 means the question is shared across quizzes.
 */
export interface QuizCatalogViolation {
  readonly questionId: QuestionId;
  readonly quizIds: readonly QuizId[];
}

/**
 * Find every question that does not belong to exactly one quiz (Requirement
 * 8.9). A question belongs to a quiz when that quiz lists its id in
 * `questionIds`. A question is a violation when the number of quizzes claiming
 * it (counting a quiz once even if it lists the id more than once, plus the
 * question's own `quizId` back-reference) is anything other than one, or when
 * the owning quiz named by `question.quizId` does not list it.
 *
 * The check is over the union of question ids drawn from the quizzes'
 * `questionIds` lists and the `questions` catalog, so both orphaned questions
 * and cross-quiz duplicates are reported.
 */
export function findQuizCatalogViolations(catalog: QuizCatalog): QuizCatalogViolation[] {
  // Map each question id to the set of quizzes that reference it.
  const claimants = new Map<QuestionId, Set<QuizId>>();
  const note = (qid: QuestionId, quizId: QuizId): void => {
    const set = claimants.get(qid) ?? new Set<QuizId>();
    set.add(quizId);
    claimants.set(qid, set);
  };

  for (const quiz of catalog.quizzes) {
    for (const qid of quiz.questionIds) {
      note(qid, quiz.id);
    }
  }
  // Ensure every catalog question is represented, and cross-check its own
  // `quizId` back-reference so an inconsistent back-reference surfaces too.
  for (const question of catalog.questions) {
    if (!claimants.has(question.id)) {
      claimants.set(question.id, new Set<QuizId>());
    }
    const owning = catalog.quizzes.find((quiz) => quiz.id === question.quizId);
    const listedByOwner = owning?.questionIds.includes(question.id) ?? false;
    if (!listedByOwner) {
      // The question's declared owner does not list it: record the mismatch by
      // ensuring the claimant set does not falsely contain the declared owner.
      claimants.get(question.id)?.delete(question.quizId);
    }
  }

  const violations: QuizCatalogViolation[] = [];
  for (const [questionId, quizIds] of claimants) {
    if (quizIds.size !== 1) {
      violations.push({ questionId, quizIds: [...quizIds].sort() });
    }
  }
  return violations.sort((x, y) => (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0));
}

/**
 * Whether the catalog satisfies the "each question belongs to exactly one quiz"
 * invariant (Requirement 8.9): true when {@link findQuizCatalogViolations}
 * reports nothing.
 */
export function isQuizCatalogValid(catalog: QuizCatalog): boolean {
  return findQuizCatalogViolations(catalog).length === 0;
}

// ---------------------------------------------------------------------------
// Serialized-view builder / self-answer withholding (Requirement 8.4)
// ---------------------------------------------------------------------------

/**
 * The view of a quiz session serialized for one partner. It mirrors
 * {@link QuizSessionState} but with the other partner's self-answers redacted
 * while they must remain withheld (Requirement 8.4).
 */
export interface QuizSessionView {
  readonly session: QuizSession;
  readonly selfAnswers: readonly QuizSelfAnswer[];
  readonly guesses: readonly QuizGuess[];
}

/**
 * Build the serialized view of a session for `viewer` (Requirement 8.4). This
 * is the pure logic that the self-answer-withholding RLS policy enforces at the
 * database layer.
 *
 * - While the session is in the `self_answer` phase, the other partner's
 *   self-answers are withheld: the view contains only the viewer's own
 *   self-answers. (No guesses exist yet in this phase.)
 * - Once the session reaches the `guessing` or `complete` phase, everything is
 *   revealed: both partners' self-answers and all guesses.
 *
 * The viewer always sees their own submissions regardless of phase.
 */
export function buildQuizSessionView(
  state: QuizSessionState,
  viewer: AccountId,
): QuizSessionView {
  if (state.session.phase === 'self_answer') {
    return {
      session: state.session,
      selfAnswers: state.selfAnswers.filter((sa) => sa.accountId === viewer),
      guesses: state.guesses.filter((g) => g.accountId === viewer),
    };
  }
  // guessing / complete: self-answers are no longer withheld.
  return {
    session: state.session,
    selfAnswers: state.selfAnswers,
    guesses: state.guesses,
  };
}
