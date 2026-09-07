import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  callFunction,
  createPairing,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  type FunctionErrorBody,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration coverage for the server-authoritative quiz Edge Function (task
// 17.3). These tests deliberately exercise the HTTP boundary, the locked SQL
// RPCs, and RLS-scoped reads together rather than re-testing the pure quiz
// state machine.
//
//   Req 8.3, 8.5  self answers advance only after both partners answer all
//   Req 8.4        partner answers are withheld, then revealed
//   Req 8.7, 8.8   guesses score and complete the session
//   Req 8.11       only one active session exists per pairing
//   Req 8.12       rejected submissions preserve the prior state
//   Property 28    the same withholding/reveal boundary holds through RLS

const cfg = getIntegrationConfig();

interface QuizSessionView {
  readonly id: string;
  readonly pairingId: string;
  readonly quizId: string;
  readonly phase: 'self_answer' | 'guessing' | 'complete';
  readonly scores: Record<string, number>;
}

interface QuizResponse {
  readonly session: QuizSessionView;
  readonly selfAnswers?: readonly { readonly accountId: string; readonly questionId: string }[];
  readonly guesses?: readonly { readonly accountId: string; readonly questionId: string }[];
  readonly results?: {
    readonly scores: Record<string, number>;
    readonly questions: readonly unknown[];
  };
}

interface QuizFixture {
  readonly a: TestAccount;
  readonly b: TestAccount;
  readonly aToken: string;
  readonly bToken: string;
  readonly aClient: SupabaseClient;
  readonly bClient: SupabaseClient;
  readonly pairingId: string;
  readonly quizId: string;
  readonly q1: string;
  readonly q2: string;
}

describe.skipIf(cfg === null)('Quiz Edge Function (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const accounts: string[] = [];
  const quizIds: string[] = [];

  async function tokenFor(client: SupabaseClient, email: string): Promise<string> {
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no access token for ${email}`);
    return token;
  }

  async function fixture(): Promise<QuizFixture> {
    const [a, b] = await Promise.all([createTestAccount(admin), createTestAccount(admin)]);
    accounts.push(a.id, b.id);
    const pairingId = await createPairing(admin, a.id, b.id);
    const [aClient, bClient] = await Promise.all([signIn(config, a), signIn(config, b)]);
    const [aToken, bToken] = await Promise.all([
      tokenFor(aClient, a.email),
      tokenFor(bClient, b.email),
    ]);

    const quiz = await admin
      .from('quiz_defs')
      .insert({ theme: `Quiz integration ${crypto.randomUUID()}` })
      .select('id')
      .single();
    if (quiz.error || !quiz.data) {
      throw new Error(`seed quiz_def failed: ${quiz.error?.message ?? 'no row'}`);
    }
    const quizId = quiz.data.id as string;
    quizIds.push(quizId);

    const questions = await admin
      .from('quiz_questions')
      .insert([
        {
          quiz_id: quizId,
          type: 'multiple_choice',
          prompt: 'Favourite colour?',
          choices: ['red', 'blue'],
        },
        { quiz_id: quizId, type: 'short_answer', prompt: 'Favourite food?' },
      ])
      .select('id, prompt');
    if (questions.error || !questions.data || questions.data.length !== 2) {
      throw new Error(
        `seed quiz_questions failed: ${questions.error?.message ?? 'wrong row count'}`,
      );
    }
    const q1 = questions.data.find((question) => question.prompt === 'Favourite colour?')?.id as
      string | undefined;
    const q2 = questions.data.find((question) => question.prompt === 'Favourite food?')?.id as
      string | undefined;
    if (!q1 || !q2) throw new Error('seeded question ids were not returned');

    return { a, b, aToken, bToken, aClient, bClient, pairingId, quizId, q1, q2 };
  }

  async function start(f: QuizFixture) {
    return await callFunction<QuizResponse & FunctionErrorBody>(
      config,
      'quiz',
      { action: 'start', quizId: f.quizId },
      f.aToken,
    );
  }

  async function selfAnswer(
    token: string,
    sessionId: string,
    questionId: string,
    answer: { kind: 'choice' | 'text'; value: string },
  ) {
    return await callFunction<QuizResponse & FunctionErrorBody>(
      config,
      'quiz',
      { action: 'self_answer', sessionId, questionId, answer },
      token,
    );
  }

  async function guess(
    token: string,
    sessionId: string,
    questionId: string,
    value: string,
    kind: 'choice' | 'text',
  ) {
    return await callFunction<QuizResponse & FunctionErrorBody>(
      config,
      'quiz',
      { action: 'guess', sessionId, questionId, guess: { kind, value } },
      token,
    );
  }

  beforeAll(async () => {
    admin = createServiceClient(config);
    if (!(await functionsRuntimeReachable(config))) {
      throw new Error(
        'Stack is configured but the Edge Functions runtime is unreachable. ' +
          'Start it with `npm run supabase:functions`.',
      );
    }
  });

  afterAll(async () => {
    // Pairing-owned sessions cascade with the test users. Catalog rows are
    // global, so remove those explicitly after their dependent sessions leave.
    await Promise.all(accounts.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
    await Promise.all(
      quizIds.map((id) =>
        admin
          .from('quiz_defs')
          .delete()
          .eq('id', id)
          .then(() => undefined),
      ),
    );
  }, 60_000);

  it('withholds self-answers until guessing, scores guesses, and exposes complete results (Req 8.3-8.8, Property 28)', async () => {
    const f = await fixture();
    const started = await start(f);
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;
    expect(started.body.session.phase).toBe('self_answer');

    // The second start is rejected by the active-session uniqueness guard and
    // does not create another active row (Req 8.11).
    const duplicateStart = await start(f);
    expect(duplicateStart.status).toBe(409);
    expect(duplicateStart.body.error?.code).toBe('QUIZ_SESSION_IN_PROGRESS');
    const activeRows = await admin
      .from('quiz_sessions')
      .select('id')
      .eq('pairing_id', f.pairingId)
      .in('phase', ['self_answer', 'guessing']);
    expect(activeRows.error).toBeNull();
    expect(activeRows.data ?? []).toHaveLength(1);

    const first = await selfAnswer(f.aToken, sessionId, f.q1, { kind: 'choice', value: 'red' });
    expect(first.status).toBe(200);
    expect(first.body.session.phase).toBe('self_answer');
    expect(first.body.selfAnswers?.map((answer) => answer.accountId)).toEqual([f.a.id]);

    // Property 28: both the response projection and RLS deny B access to A's
    // answer while the session remains in self_answer.
    const withheld = await f.bClient
      .from('quiz_self_answers')
      .select('account_id, answer')
      .eq('session_id', sessionId);
    expect(withheld.error).toBeNull();
    expect((withheld.data ?? []).map((row) => row.account_id)).not.toContain(f.a.id);

    // A rejected duplicate leaves the original answer and phase intact (Req 8.12).
    const rejected = await selfAnswer(f.aToken, sessionId, f.q1, { kind: 'choice', value: 'blue' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error?.code).toBe('ALREADY_ANSWERED');
    const preserved = await admin
      .from('quiz_self_answers')
      .select('answer')
      .eq('session_id', sessionId)
      .eq('account_id', f.a.id)
      .eq('question_id', f.q1)
      .single();
    expect(preserved.error).toBeNull();
    expect(preserved.data?.answer).toEqual({ kind: 'choice', value: 'red' });
    const phaseAfterReject = await admin
      .from('quiz_sessions')
      .select('phase')
      .eq('id', sessionId)
      .single();
    expect(phaseAfterReject.data?.phase).toBe('self_answer');

    expect(
      (await selfAnswer(f.aToken, sessionId, f.q2, { kind: 'text', value: 'Pizza' })).status,
    ).toBe(200);
    expect(
      (await selfAnswer(f.bToken, sessionId, f.q1, { kind: 'choice', value: 'blue' })).status,
    ).toBe(200);
    const revealed = await selfAnswer(f.bToken, sessionId, f.q2, { kind: 'text', value: 'tacos' });
    expect(revealed.status).toBe(200);
    expect(revealed.body.session.phase).toBe('guessing');
    expect(revealed.body.selfAnswers).toHaveLength(4);
    expect(revealed.body.selfAnswers?.map((answer) => answer.accountId)).toContain(f.a.id);
    const visibleInGuessing = await f.bClient
      .from('quiz_self_answers')
      .select('account_id')
      .eq('session_id', sessionId);
    expect(visibleInGuessing.error).toBeNull();
    expect((visibleInGuessing.data ?? []).map((row) => row.account_id)).toEqual(
      expect.arrayContaining([f.a.id, f.b.id]),
    );

    expect(
      (await guess(f.aToken, sessionId, f.q1, 'blue', 'choice')).body.session.scores[f.a.id],
    ).toBe(1);
    expect(
      (await guess(f.aToken, sessionId, f.q2, '  TACOS ', 'text')).body.session.scores[f.a.id],
    ).toBe(2);
    expect(
      (await guess(f.bToken, sessionId, f.q1, 'red', 'choice')).body.session.scores[f.b.id],
    ).toBe(1);
    const complete = await guess(f.bToken, sessionId, f.q2, 'pasta', 'text');
    expect(complete.status).toBe(200);
    expect(complete.body.session.phase).toBe('complete');
    expect(complete.body.session.scores).toMatchObject({ [f.a.id]: 2, [f.b.id]: 1 });
    expect(complete.body.results?.scores).toMatchObject({ [f.a.id]: 2, [f.b.id]: 1 });
    expect(complete.body.results?.questions).toHaveLength(2);

    // RLS remains revealed after completion (the phase transition is durable).
    const visibleWhenComplete = await f.bClient
      .from('quiz_self_answers')
      .select('account_id')
      .eq('session_id', sessionId);
    expect(visibleWhenComplete.error).toBeNull();
    expect((visibleWhenComplete.data ?? []).map((row) => row.account_id)).toEqual(
      expect.arrayContaining([f.a.id, f.b.id]),
    );
  }, 60_000);

  it('rejects a stale-epoch token before it can start a quiz', async () => {
    const f = await fixture();
    const displaced = await admin
      .from('account_session')
      .update({ epoch: 1, updated_at: new Date().toISOString() })
      .eq('account_id', f.a.id);
    expect(displaced.error).toBeNull();

    const stale = await start(f);
    expect(stale.status).toBe(401);
    expect(stale.body.error?.code).toBe('SESSION_SUPERSEDED');
    const sessions = await admin.from('quiz_sessions').select('id').eq('pairing_id', f.pairingId);
    expect(sessions.error).toBeNull();
    expect(sessions.data ?? []).toHaveLength(0);
  });
});
