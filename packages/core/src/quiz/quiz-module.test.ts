import { describe, expect, it } from 'vitest';

import { accountId, pairingId, questionId, quizId, sessionId } from '../domain/common.js';
import { ERROR_CODES, type QuizError } from '../errors.js';
import { isErr, isOk } from '../result.js';
import {
  createQuizModule,
  type QuizMutationOutcome,
  type QuizPorts,
  type QuizSessionSnapshot,
} from './quiz-module.js';

const ALICE = accountId('11111111-1111-4111-8111-111111111111');
const BOB = accountId('22222222-2222-4222-8222-222222222222');
const PAIRING = pairingId('33333333-3333-4333-8333-333333333333');
const QUIZ = quizId('44444444-4444-4444-8444-444444444444');
const SESSION = sessionId('55555555-5555-4555-8555-555555555555');
const QUESTION = questionId('66666666-6666-4666-8666-666666666666');

function snapshot(overrides: Partial<QuizSessionSnapshot> = {}): QuizSessionSnapshot {
  return {
    session: {
      id: SESSION,
      pairingId: PAIRING,
      quizId: QUIZ,
      phase: 'self_answer',
      scores: { [ALICE]: 0, [BOB]: 0 },
    },
    selfAnswers: [],
    guesses: [],
    ...overrides,
  };
}

function refusal(code: QuizError['code']): QuizMutationOutcome {
  return { ok: false, error: { code, message: code } };
}

function harness(overrides: Partial<QuizPorts> = {}) {
  const ports: QuizPorts = {
    listQuizzes: async () => [{ id: QUIZ, theme: 'Favorites', questionIds: [QUESTION] }],
    fetchSession: async () => snapshot(),
    startSession: async () => ({ ok: true, snapshot: snapshot() }),
    submitSelfAnswer: async () => ({ ok: true, snapshot: snapshot() }),
    submitGuess: async () => ({ ok: true, snapshot: snapshot() }),
    ...overrides,
  };
  return { module: createQuizModule(ports), ports };
}

describe('QuizModule catalog and mutations', () => {
  it('reads the themed catalog from the caller-scoped port (Req 8.1)', async () => {
    const quizzes = await harness().module.listQuizzes();
    expect(quizzes).toEqual([{ id: QUIZ, theme: 'Favorites', questionIds: [QUESTION] }]);
  });

  it('caches the Edge Function-created zero-score self-answer session', async () => {
    const h = harness();
    const result = await h.module.startSession(QUIZ);
    expect(isOk(result)).toBe(true);
    expect(h.module.cached(SESSION)?.session).toMatchObject({
      phase: 'self_answer',
      scores: { [ALICE]: 0, [BOB]: 0 },
    });
  });

  it('passes an answer intent to the authoritative port and caches its returned phase', async () => {
    let received: unknown;
    const h = harness({
      submitSelfAnswer: async (_session, _question, answer) => {
        received = answer;
        return {
          ok: true,
          snapshot: snapshot({
            selfAnswers: [{ sessionId: SESSION, accountId: ALICE, questionId: QUESTION, answer }],
          }),
        };
      },
    });
    await h.module.submitSelfAnswer(SESSION, QUESTION, { kind: 'text', value: 'Morning' });
    expect(received).toEqual({ kind: 'text', value: 'Morning' });
    expect(h.module.cached(SESSION)?.selfAnswers).toHaveLength(1);
  });

  it('surfaces server refusals without changing the cached session', async () => {
    const h = harness({
      submitGuess: async () => refusal(ERROR_CODES.WRONG_PHASE),
    });
    await h.module.startSession(QUIZ);
    const before = h.module.cached(SESSION);

    const result = await h.module.submitGuess(SESSION, QUESTION, {
      kind: 'text',
      value: 'Morning',
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.WRONG_PHASE);
    expect(h.module.cached(SESSION)).toBe(before);
  });
});

describe('QuizModule RLS-backed session reads and results', () => {
  it('keeps the RLS-filtered self-answer view supplied by the read port', async () => {
    // During self_answer the adapter's direct table read is limited by RLS to
    // Alice's own row. The module must not fill the missing partner row from a
    // cache or an Edge Function response.
    const h = harness({
      fetchSession: async () =>
        snapshot({
          selfAnswers: [
            {
              sessionId: SESSION,
              accountId: ALICE,
              questionId: QUESTION,
              answer: { kind: 'text', value: 'Morning' },
            },
          ],
        }),
    });
    const read = await h.module.refreshSession(SESSION);
    expect(read?.selfAnswers).toEqual([
      {
        sessionId: SESSION,
        accountId: ALICE,
        questionId: QUESTION,
        answer: { kind: 'text', value: 'Morning' },
      },
    ]);
    expect(read?.selfAnswers.some((answer) => answer.accountId === BOB)).toBe(false);
  });

  it('returns full answers, guesses, and final scores only from a complete read', async () => {
    const complete = snapshot({
      session: {
        id: SESSION,
        pairingId: PAIRING,
        quizId: QUIZ,
        phase: 'complete',
        scores: { [ALICE]: 1, [BOB]: 0 },
      },
      results: {
        sessionId: SESSION,
        quizId: QUIZ,
        scores: { [ALICE]: 1, [BOB]: 0 },
        questions: [
          {
            questionId: QUESTION,
            selfAnswers: {
              [ALICE]: { kind: 'text', value: 'Morning' },
              [BOB]: { kind: 'text', value: 'Morning' },
            },
            guesses: {
              [ALICE]: { kind: 'text', value: 'Morning' },
              [BOB]: { kind: 'text', value: 'Evening' },
            },
          },
        ],
      },
    });
    const h = harness({ fetchSession: async () => complete });
    expect(await h.module.getResults(SESSION)).toEqual(complete.results);
  });

  it('does not surface results before completion', async () => {
    expect(await harness().module.getResults(SESSION)).toBeNull();
  });
});
