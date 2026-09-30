import { describe, expect, it } from 'vitest';
import {
  accountId,
  pairingId,
  questionId,
  quizId,
  sessionId,
  type QuizQuestion,
  type QuizSessionSnapshot,
} from '@ldr/core';

import {
  answerLabel,
  editableQuizQuestions,
  nextQuizQuestion,
  quizDraftComplete,
  quizProgress,
} from './couples-quiz-view';

const SELF = accountId('11111111-1111-4111-8111-111111111111');
const PARTNER = accountId('22222222-2222-4222-8222-222222222222');
const QUIZ = quizId('33333333-3333-4333-8333-333333333333');
const Q1 = questionId('44444444-4444-4444-8444-444444444444');
const Q2 = questionId('55555555-5555-4555-8555-555555555555');
const questions: readonly QuizQuestion[] = [
  { id: Q1, quizId: QUIZ, type: 'short_answer', prompt: 'One?' },
  { id: Q2, quizId: QUIZ, type: 'short_answer', prompt: 'Two?' },
];

function snapshot(phase: QuizSessionSnapshot['session']['phase']): QuizSessionSnapshot {
  return {
    session: {
      id: sessionId('66666666-6666-4666-8666-666666666666'),
      pairingId: pairingId('77777777-7777-4777-8777-777777777777'),
      quizId: QUIZ,
      phase,
      scores: { [SELF]: 0, [PARTNER]: 0 },
    },
    selfAnswers: [],
    guesses: [],
  };
}

describe('Couples Quiz presentation', () => {
  it('advances through only the current player’s self answers', () => {
    const initial = snapshot('self_answer');
    const state: QuizSessionSnapshot = {
      ...initial,
      selfAnswers: [
        {
          sessionId: initial.session.id,
          accountId: SELF,
          questionId: Q1,
          answer: { kind: 'text', value: 'A' },
        },
      ],
    };
    expect(nextQuizQuestion(questions, state, SELF)?.id).toBe(Q2);
    expect(quizProgress(questions, state, SELF)).toEqual({ completed: 1, total: 2 });
  });

  it('uses guesses during the guessing phase and stops at completion', () => {
    const initial = snapshot('guessing');
    const state: QuizSessionSnapshot = {
      ...initial,
      guesses: [
        {
          sessionId: initial.session.id,
          accountId: SELF,
          questionId: Q1,
          guess: { kind: 'text', value: 'B' },
        },
      ],
    };
    expect(nextQuizQuestion(questions, state, SELF)?.id).toBe(Q2);
    expect(
      nextQuizQuestion(
        questions,
        { ...state, session: { ...state.session, phase: 'complete' } },
        SELF,
      ),
    ).toBeNull();
  });

  it('presents answer values with a safe empty fallback', () => {
    expect(answerLabel({ kind: 'choice', value: 'A movie marathon' })).toBe('A movie marathon');
    expect(answerLabel(null)).toBe('No answer');
  });

  it('keeps unsubmitted drafts editable and excludes answers already committed on retry', () => {
    const initial = snapshot('self_answer');
    expect(editableQuizQuestions(questions, initial, SELF)).toEqual(questions);
    expect(quizDraftComplete(questions, { [Q1]: 'First', [Q2]: '  ' })).toBe(false);
    expect(quizDraftComplete(questions, { [Q1]: 'Revised first', [Q2]: 'Second' })).toBe(true);

    const partlySubmitted: QuizSessionSnapshot = {
      ...initial,
      selfAnswers: [
        {
          sessionId: initial.session.id,
          accountId: SELF,
          questionId: Q1,
          answer: { kind: 'text', value: 'Revised first' },
        },
      ],
    };
    expect(editableQuizQuestions(questions, partlySubmitted, SELF)).toEqual([questions[1]]);
  });
});
