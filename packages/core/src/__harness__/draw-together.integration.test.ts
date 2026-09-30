import type { SupabaseClient } from '@supabase/supabase-js';

import { drawTogetherWordMask } from '../domain/rt-draw-together.js';

import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

const cfg = getIntegrationConfig();

interface SessionView {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: 'pending' | 'active' | 'paused' | 'terminal';
  readonly gameState: Record<string, unknown>;
}

interface Choice {
  readonly id: string;
  readonly word: string;
  readonly difficulty: 'easy' | 'medium' | 'hard';
}

interface DrawResponse {
  readonly session: SessionView;
  readonly choices?: readonly Choice[];
  readonly word?: string;
  readonly correct?: boolean;
  readonly bestScore?: number;
}

describe.skipIf(cfg === null)('Draw Together (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  async function member(): Promise<{
    account: TestAccount;
    token: string;
    client: SupabaseClient;
  }> {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, token, client };
  }

  async function pair(aToken: string, bToken: string): Promise<void> {
    const invitation = await callFunction<{ invitation: { code: string } }>(
      config,
      'create-invitation',
      {},
      aToken,
    );
    expect(invitation.status).toBe(201);
    const accepted = await callFunction(
      config,
      'accept-invitation',
      { code: invitation.body.invitation.code },
      bToken,
    );
    expect(accepted.status).toBe(201);
  }

  async function activeSession(aToken: string, bToken: string): Promise<SessionView> {
    const invited = await callFunction<{ session: SessionView }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'draw-together' },
      aToken,
    );
    expect(invited.status).toBe(201);
    const id = invited.body.session.id;
    expect(
      (await callFunction(config, 'rt-move', { action: 'join', sessionId: id }, aToken)).status,
    ).toBe(200);
    const joined = await callFunction<{ session: SessionView }>(
      config,
      'rt-move',
      { action: 'join', sessionId: id },
      bToken,
    );
    expect(joined.status).toBe(200);
    return joined.body.session;
  }

  beforeAll(async () => {
    admin = createServiceClient(config);
    if (!(await functionsRuntimeReachable(config))) {
      throw new Error('Start the local Edge Functions runtime before integration tests.');
    }
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  it('keeps choices private, validates guesses, scores once, and alternates roles', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);
    const active = await activeSession(a.token, b.token);

    const started = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'start', sessionId: active.id, durationSeconds: 180 },
      a.token,
    );
    expect(started.status).toBe(200);
    expect(started.body.choices).toHaveLength(3);
    expect(started.body.choices?.map((choice) => choice.difficulty).sort()).toEqual([
      'easy',
      'hard',
      'medium',
    ]);

    const [{ error: secretRead }, { error: catalogRead }] = await Promise.all([
      b.client.from('draw_together_secrets').select('*'),
      b.client.from('draw_together_words').select('*'),
    ]);
    expect(secretRead).not.toBeNull();
    expect(catalogRead).not.toBeNull();

    const partnerView = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'state', sessionId: active.id },
      b.token,
    );
    expect(partnerView.status).toBe(200);
    expect(partnerView.body.choices).toBeUndefined();
    for (const choice of started.body.choices ?? []) {
      expect(JSON.stringify(partnerView.body.session.gameState)).not.toContain(choice.word);
    }

    const chosen = started.body.choices?.find((choice) => choice.difficulty === 'easy');
    if (!chosen) throw new Error('missing easy choice');
    const drawing = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'choose', sessionId: active.id, choiceId: chosen.id },
      a.token,
    );
    expect(drawing.status).toBe(200);
    expect(drawing.body.word).toBe(chosen.word);
    expect(drawing.body.session.gameState.maskedWordPattern).toBe(
      drawTogetherWordMask(chosen.word),
    );
    expect(
      Number(drawing.body.session.gameState.matchEndsAt) -
        Number(drawing.body.session.gameState.turnStartedAt),
    ).toBe(180_000);

    const guesserView = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'state', sessionId: active.id },
      b.token,
    );
    expect(guesserView.body.word).toBeUndefined();
    expect(JSON.stringify(guesserView.body.session.gameState)).not.toContain(chosen.word);

    const wrong = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'guess', sessionId: active.id, guess: 'definitely wrong' },
      b.token,
    );
    expect(wrong.status).toBe(200);
    expect(wrong.body.correct).toBe(false);

    const correct = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'guess', sessionId: active.id, guess: chosen.word.toUpperCase() },
      b.token,
    );
    expect(correct.status).toBe(200);
    expect(correct.body.correct).toBe(true);
    expect(correct.body.session.gameState).toMatchObject({
      phase: 'choosing',
      drawer: b.account.id,
      guesser: a.account.id,
      solvedCount: 1,
      turn: 1,
    });
    expect(Number(correct.body.session.gameState.score)).toBeGreaterThan(0);
    expect(correct.body.choices).toHaveLength(3);
    expect(JSON.stringify(correct.body.session.gameState)).toContain(chosen.word);

    const replay = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'guess', sessionId: active.id, guess: chosen.word },
      b.token,
    );
    expect(replay.status).toBe(400);

    const nextChoice = correct.body.choices?.[0];
    if (!nextChoice) throw new Error('missing next word choices');
    const secondDrawing = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'choose', sessionId: active.id, choiceId: nextChoice.id },
      b.token,
    );
    expect(secondDrawing.status).toBe(200);

    const expiredAt = Date.now() - 1;
    const expiredState = {
      ...secondDrawing.body.session.gameState,
      matchEndsAt: expiredAt,
      turnEndsAt: expiredAt,
    };
    const { error: expireError } = await admin
      .from('rt_sessions')
      .update({ game_state: expiredState })
      .eq('id', active.id);
    expect(expireError).toBeNull();

    const finished = await callFunction<DrawResponse>(
      config,
      'draw-together',
      { action: 'state', sessionId: active.id },
      a.token,
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.session.state).toBe('terminal');
    expect(finished.body.session.gameState).toMatchObject({ phase: 'finished', solvedCount: 1 });
    const attempts = finished.body.session.gameState.attempts as readonly {
      readonly word: string;
      readonly result: string;
      readonly points: number;
    }[];
    expect(attempts.at(-1)).toMatchObject({
      word: secondDrawing.body.word,
      result: 'missed',
      points: 0,
    });
    expect(finished.body.bestScore).toBe(Number(finished.body.session.gameState.score));
  });
});
