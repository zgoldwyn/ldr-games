import { describe, expect, it } from 'vitest';

import { accountId, pairingId, questionId, quizId, sessionId } from './common.js';
import type { QuizDef, QuizQuestion } from './quiz.js';
import {
  bothAnsweredAll,
  bothGuessedAll,
  buildQuizResults,
  buildQuizSessionView,
  checkNoActiveQuizSession,
  createQuizSession,
  findQuizCatalogViolations,
  isQuizCatalogValid,
  isQuizSessionActive,
  recordGuess,
  recordSelfAnswer,
  sessionPartners,
  type QuizSessionState,
} from './quiz-session.js';

const A = accountId('account-a');
const B = accountId('account-b');
const PAIRING = pairingId('pairing-1');
const QUIZ = quizId('quiz-1');
const SESSION = sessionId('session-1');
const Q1 = questionId('q1');
const Q2 = questionId('q2');

/** Two-question quiz: one multiple-choice, one short-answer. */
const QUESTIONS: readonly QuizQuestion[] = [
  { id: Q1, quizId: QUIZ, type: 'multiple_choice', prompt: 'Fav color?', choices: ['red', 'blue'] },
  { id: Q2, quizId: QUIZ, type: 'short_answer', prompt: 'Fav food?' },
];

function freshState(): QuizSessionState {
  return createQuizSession({ id: SESSION, pairingId: PAIRING, quizId: QUIZ, partners: [A, B] });
}

/** Unwrap a successful Result or fail the test loudly. */
function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('createQuizSession (Requirement 8.2)', () => {
  it('starts in the self-answer phase with no answers, no guesses, and zero scores', () => {
    const state = freshState();
    expect(state.session.phase).toBe('self_answer');
    expect(state.selfAnswers).toEqual([]);
    expect(state.guesses).toEqual([]);
    expect(state.session.scores).toEqual({ [A]: 0, [B]: 0 });
  });

  it('returns both partners sorted deterministically', () => {
    const state = freshState();
    expect(sessionPartners(state.session)).toEqual([A, B].slice().sort());
  });
});

describe('recordSelfAnswer and phase progression (Requirements 8.3, 8.5)', () => {
  it('records a valid self-answer and stays in self_answer until both answer all', () => {
    let state = freshState();
    state = expectOk(
      recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'red' } }),
    );
    expect(state.selfAnswers).toHaveLength(1);
    expect(state.session.phase).toBe('self_answer');
    expect(bothAnsweredAll(state, [Q1, Q2])).toBe(false);
  });

  it('transitions to guessing only when both partners answered every question', () => {
    let state = freshState();
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'red' } }));
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q2, answer: { kind: 'text', value: 'pizza' } }));
    expect(state.session.phase).toBe('self_answer');
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: B, questionId: Q1, answer: { kind: 'choice', value: 'blue' } }));
    expect(state.session.phase).toBe('self_answer');
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: B, questionId: Q2, answer: { kind: 'text', value: 'tacos' } }));
    expect(state.session.phase).toBe('guessing');
    expect(bothAnsweredAll(state, [Q1, Q2])).toBe(true);
  });

  it('rejects duplicate, invalid, unknown-question, and wrong-phase submissions, retaining prior state', () => {
    let state = freshState();
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'red' } }));

    const dup = recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'blue' } });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('ALREADY_ANSWERED');

    const invalid = recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q2, answer: { kind: 'text', value: '' } });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_ANSWER');

    const unknown = recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: questionId('nope'), answer: { kind: 'text', value: 'x' } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('QUESTION_NOT_FOUND');

    // Original self-answer preserved (Requirement 8.12).
    expect(state.selfAnswers).toHaveLength(1);
  });
});

describe('recordGuess, scoring, and completion (Requirements 8.7, 8.8)', () => {
  function guessingState(): QuizSessionState {
    let state = freshState();
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'red' } }));
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q2, answer: { kind: 'text', value: 'Pizza' } }));
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: B, questionId: Q1, answer: { kind: 'choice', value: 'blue' } }));
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: B, questionId: Q2, answer: { kind: 'text', value: 'tacos' } }));
    return state;
  }

  it('awards a point when a guess matches the other partner self-answer and completes when both guessed all', () => {
    let state = guessingState();
    expect(state.session.phase).toBe('guessing');

    // A guesses B's answers: B answered blue / tacos.
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: A, questionId: Q1, guess: { kind: 'choice', value: 'blue' } }));
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: A, questionId: Q2, guess: { kind: 'text', value: '  TACOS ' } }));
    expect(state.session.scores[A]).toBe(2); // both correct (case/whitespace insensitive)

    // B guesses A's answers: A answered red / Pizza. B gets one right.
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: B, questionId: Q1, guess: { kind: 'choice', value: 'red' } }));
    expect(state.session.phase).toBe('guessing');
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: B, questionId: Q2, guess: { kind: 'text', value: 'sushi' } }));

    expect(state.session.phase).toBe('complete');
    expect(state.session.scores[B]).toBe(1);
    expect(bothGuessedAll(state, [Q1, Q2])).toBe(true);
  });

  it('builds full results with both self-answers, guesses, and scores', () => {
    let state = guessingState();
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: A, questionId: Q1, guess: { kind: 'choice', value: 'blue' } }));
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: A, questionId: Q2, guess: { kind: 'text', value: 'tacos' } }));
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: B, questionId: Q1, guess: { kind: 'choice', value: 'red' } }));
    state = expectOk(recordGuess(state, QUESTIONS, { accountId: B, questionId: Q2, guess: { kind: 'text', value: 'pizza' } }));

    const results = buildQuizResults(state, QUESTIONS);
    expect(results.questions).toHaveLength(2);
    const q1 = results.questions.find((q) => q.questionId === Q1)!;
    expect(q1.selfAnswers[A]).toEqual({ kind: 'choice', value: 'red' });
    expect(q1.selfAnswers[B]).toEqual({ kind: 'choice', value: 'blue' });
    expect(q1.guesses[A]).toEqual({ kind: 'choice', value: 'blue' });
    expect(q1.guesses[B]).toEqual({ kind: 'choice', value: 'red' });
    expect(results.scores).toEqual(state.session.scores);
  });

  it('rejects a guess submitted in the wrong phase', () => {
    const state = freshState(); // self_answer phase
    const res = recordGuess(state, QUESTIONS, { accountId: A, questionId: Q1, guess: { kind: 'choice', value: 'red' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('WRONG_PHASE');
  });
});

describe('checkNoActiveQuizSession (Requirement 8.11)', () => {
  it('rejects when an active session already exists for the pairing', () => {
    const existing = [{ pairingId: PAIRING, phase: 'guessing' as const }];
    const res = checkNoActiveQuizSession(PAIRING, existing);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('QUIZ_SESSION_IN_PROGRESS');
  });

  it('allows a new session when existing sessions are complete or for other pairings', () => {
    const existing = [
      { pairingId: PAIRING, phase: 'complete' as const },
      { pairingId: pairingId('other'), phase: 'guessing' as const },
    ];
    expect(checkNoActiveQuizSession(PAIRING, existing).ok).toBe(true);
  });

  it('treats self_answer and guessing as active, complete as inactive', () => {
    expect(isQuizSessionActive({ phase: 'self_answer' })).toBe(true);
    expect(isQuizSessionActive({ phase: 'guessing' })).toBe(true);
    expect(isQuizSessionActive({ phase: 'complete' })).toBe(false);
  });
});

describe('findQuizCatalogViolations (Requirement 8.9)', () => {
  const quizA: QuizDef = { id: quizId('qa'), theme: 'A', questionIds: [Q1] };
  const quizB: QuizDef = { id: quizId('qb'), theme: 'B', questionIds: [Q2] };

  it('reports no violations when each question belongs to exactly one quiz', () => {
    const catalog = {
      quizzes: [quizA, quizB],
      questions: [
        { id: Q1, quizId: quizId('qa'), type: 'short_answer', prompt: 'p1' },
        { id: Q2, quizId: quizId('qb'), type: 'short_answer', prompt: 'p2' },
      ] as QuizQuestion[],
    };
    expect(findQuizCatalogViolations(catalog)).toEqual([]);
    expect(isQuizCatalogValid(catalog)).toBe(true);
  });

  it('flags a question shared across two quizzes', () => {
    const catalog = {
      quizzes: [
        { id: quizId('qa'), theme: 'A', questionIds: [Q1] },
        { id: quizId('qb'), theme: 'B', questionIds: [Q1] },
      ],
      questions: [{ id: Q1, quizId: quizId('qa'), type: 'short_answer', prompt: 'p1' }] as QuizQuestion[],
    };
    const violations = findQuizCatalogViolations(catalog);
    expect(violations).toHaveLength(1);
    expect(violations[0].questionId).toBe(Q1);
    expect(violations[0].quizIds).toEqual([quizId('qa'), quizId('qb')].slice().sort());
    expect(isQuizCatalogValid(catalog)).toBe(false);
  });

  it('flags an orphaned question that belongs to no quiz', () => {
    const catalog = {
      quizzes: [] as QuizDef[],
      questions: [{ id: Q1, quizId: quizId('qa'), type: 'short_answer', prompt: 'p1' }] as QuizQuestion[],
    };
    const violations = findQuizCatalogViolations(catalog);
    expect(violations).toHaveLength(1);
    expect(violations[0].quizIds).toEqual([]);
  });
});

describe('buildQuizSessionView self-answer redaction (Requirement 8.4)', () => {
  function bothAnsweredOne(): QuizSessionState {
    let state = freshState();
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: A, questionId: Q1, answer: { kind: 'choice', value: 'red' } }));
    state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: B, questionId: Q1, answer: { kind: 'choice', value: 'blue' } }));
    return state;
  }

  it('withholds the other partner self-answers during the self-answer phase', () => {
    const state = bothAnsweredOne();
    expect(state.session.phase).toBe('self_answer');

    const viewA = buildQuizSessionView(state, A);
    expect(viewA.selfAnswers).toHaveLength(1);
    expect(viewA.selfAnswers.every((sa) => sa.accountId === A)).toBe(true);

    const viewB = buildQuizSessionView(state, B);
    expect(viewB.selfAnswers.every((sa) => sa.accountId === B)).toBe(true);
  });

  it('reveals both partners self-answers once past the self-answer phase', () => {
    // Complete all self-answers to reach guessing phase.
    let state = freshState();
    for (const acct of [A, B]) {
      state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: acct, questionId: Q1, answer: { kind: 'choice', value: 'red' } }));
      state = expectOk(recordSelfAnswer(state, QUESTIONS, { accountId: acct, questionId: Q2, answer: { kind: 'text', value: 'pizza' } }));
    }
    expect(state.session.phase).toBe('guessing');

    const view = buildQuizSessionView(state, A);
    expect(view.selfAnswers).toHaveLength(4);
    expect(view.selfAnswers.some((sa) => sa.accountId === B)).toBe(true);
  });
});
