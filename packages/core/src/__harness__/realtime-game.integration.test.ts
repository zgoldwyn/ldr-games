import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import {
  callFunction,
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

// Integration tests for the real-time game wiring (task 15.3): the `rt-move`
// Edge Function with Broadcast fan-out (15.1) and the Presence-driven
// pause/rejoin functions (15.2).
//
//   Req 6.2   an invitation reaches the partner within 5 seconds
//   Req 6.3   both partners joining inside the window yields identical state
//   Req 6.4   a valid move is reflected on both clients within 2 seconds
//   Req 6.5   starting without a pairing is refused
//   Req 6.6   30 continuous seconds of disconnect pauses and preserves state
//   Req 6.7   rejoin within 5 minutes resumes from the preserved state
//   Req 6.11  an invalid move is rejected with state unchanged
//
// The latency assertions are the point of this suite: they are the only place the
// Broadcast path is exercised at all, and Broadcast is what makes Req 6.4's 2s
// budget achievable (the durable row is the fallback, not the fast path).
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** Req 6.4 budget. */
const MOVE_BUDGET_MS = 2_000;
/** Req 6.2 budget. */
const INVITE_BUDGET_MS = 5_000;
/** The continuous disconnect that pauses a session (Req 6.6). */
const DISCONNECT_THRESHOLD_MS = 30_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

interface RTSessionView {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: 'pending' | 'active' | 'paused' | 'terminal';
  readonly gameState: Record<string, unknown>;
  readonly outcome: unknown;
}

interface TicTacToeState {
  readonly game: string;
  readonly board: readonly (string | null)[];
  readonly currentTurn: string;
  readonly players: readonly [string, string];
  readonly status: string;
}

/** A captured Broadcast message with the moment it arrived. */
interface Captured {
  readonly event: string;
  readonly at: number;
  readonly payload: Record<string, unknown>;
}

describe.skipIf(cfg === null)('Real-time game wiring (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];
  const channels: { client: SupabaseClient; channel: RealtimeChannel }[] = [];

  async function member(): Promise<{
    account: TestAccount;
    id: string;
    token: string;
    client: SupabaseClient;
  }> {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const { data } = await client.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error(`no token for ${account.email}`);
    return { account, id: account.id, token, client };
  }

  async function pair(aToken: string, bToken: string): Promise<string> {
    const inv = await callFunction<{ invitation: { code: string } }>(
      config,
      'create-invitation',
      {},
      aToken,
    );
    expect(inv.status).toBe(201);
    const accepted = await callFunction<{ pairing: { id: string } }>(
      config,
      'accept-invitation',
      { code: inv.body.invitation.code },
      bToken,
    );
    expect(accepted.status).toBe(201);
    return accepted.body.pairing.id;
  }

  /**
   * Subscribe to every Broadcast event on `topic`, capturing arrival times.
   * Resolves once the channel is actually SUBSCRIBED, so a latency measurement
   * taken afterwards is not really measuring the handshake.
   */
  async function listen(client: SupabaseClient, topic: string): Promise<Captured[]> {
    const captured: Captured[] = [];
    const channel = client.channel(topic);
    channel.on('broadcast', { event: '*' }, (message) => {
      captured.push({
        event: String(message.event),
        at: Date.now(),
        payload: (message.payload ?? {}) as Record<string, unknown>,
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`channel ${topic} never subscribed`)),
        SUBSCRIBE_TIMEOUT_MS,
      );
      channel.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error(`channel ${topic} failed: ${status}`));
        }
      });
    });

    channels.push({ client, channel });
    return captured;
  }

  /** Wait for a named Broadcast event, returning its arrival time or null. */
  async function waitForEvent(
    captured: readonly Captured[],
    event: string,
    budgetMs: number,
  ): Promise<Captured | null> {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
      const hit = captured.find((c) => c.event === event);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    return captured.find((c) => c.event === event) ?? null;
  }

  /** Invite, then have both partners join, returning the active session. */
  async function activeSession(
    a: { token: string },
    b: { token: string },
  ): Promise<RTSessionView> {
    const invited = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );
    expect(invited.status).toBe(201);
    const sessionId = invited.body.session.id;

    const joinA = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'join', sessionId },
      a.token,
    );
    expect(joinA.status).toBe(200);

    const joinB = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'join', sessionId },
      b.token,
    );
    expect(joinB.status).toBe(200);
    return joinB.body.session;
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
    await Promise.all(
      channels.map(({ client, channel }) => client.removeChannel(channel).catch(() => undefined)),
    );
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  // -------------------------------------------------------------------------
  // Req 6.1 / 6.5 — catalog and the pairing requirement
  // -------------------------------------------------------------------------
  it('presents the game catalog to a paired account and refuses an unpaired one (Req 6.1, 6.5)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const games = await callFunction<{ games: { id: string; name: string }[] }>(
      config,
      'rt-move',
      { action: 'games' },
      a.token,
    );
    expect(games.status).toBe(200);
    expect(games.body.games.map((g) => g.id)).toContain('tic-tac-toe');

    // Req 6.5: no partner, no session.
    const lonely = await member();
    const refused = await callFunction<FunctionErrorBody>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      lonely.token,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('PAIRING_REQUIRED');

    // The catalog is gated on the pairing too, so an unpaired account sees no
    // shared feature at all.
    const lonelyCatalog = await callFunction<FunctionErrorBody>(
      config,
      'rt-move',
      { action: 'games' },
      lonely.token,
    );
    expect(lonelyCatalog.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Req 6.2 — the invitation reaches the partner within 5 seconds
  // -------------------------------------------------------------------------
  it('delivers a game invitation to the partner within 5 seconds (Req 6.2)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    // The partner listens on their per-account channel, which is where the live
    // invite signal is published.
    const captured = await listen(b.client, `account:${b.id}`);

    const started = Date.now();
    const invited = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );
    expect(invited.status).toBe(201);
    // The session starts pending, awaiting the join window (Req 6.2).
    expect(invited.body.session.state).toBe('pending');

    const hit = await waitForEvent(captured, 'game_invite', INVITE_BUDGET_MS);
    expect(hit).not.toBeNull();
    expect((hit as Captured).at - started).toBeLessThan(INVITE_BUDGET_MS);

    // And a DURABLE notification exists, so a partner who was offline still gets
    // it on next sign-in rather than depending on the broadcast.
    const { data } = await admin
      .from('notifications')
      .select('category, payload, delivered_at')
      .eq('recipient_account_id', b.id);
    const invite = (data ?? []).find(
      (n) => (n.payload as { type?: string })?.type === 'rt_game_invite',
    );
    expect(invite).toBeDefined();
    expect(invite?.category).toBe('game_invite');
    expect(invite?.delivered_at).toBeNull();
  });

  it('refuses a fourth open real-time session of the same game type', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    for (let i = 0; i < 3; i += 1) {
      const invited = await callFunction<{ session: RTSessionView }>(
        config,
        'rt-move',
        { action: 'invite', gameId: 'tic-tac-toe' },
        a.token,
      );
      expect(invited.status).toBe(201);
    }

    const fourth = await callFunction<FunctionErrorBody>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );

    expect(fourth.status).toBe(409);
    expect(fourth.body.error?.code).toBe('INVALID_SESSION_STATE');
  });

  // -------------------------------------------------------------------------
  // Req 6.3 — both joining yields identical active state
  // -------------------------------------------------------------------------
  it('activates with identical state once both partners join (Req 6.3)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const invited = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'invite', gameId: 'tic-tac-toe' },
      a.token,
    );
    const sessionId = invited.body.session.id;

    // One partner alone is not enough: the session stays pending.
    const joinA = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'join', sessionId },
      a.token,
    );
    expect(joinA.body.session.state).toBe('pending');

    const joinB = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'join', sessionId },
      b.token,
    );
    expect(joinB.body.session.state).toBe('active');

    // Both partners read the SAME authoritative row, so "identical state" is
    // asserted by reading it back as each of them.
    const asA = await a.client.from('rt_sessions').select('game_state').eq('id', sessionId).single();
    const asB = await b.client.from('rt_sessions').select('game_state').eq('id', sessionId).single();
    expect(asA.error).toBeNull();
    expect(asB.error).toBeNull();
    expect(asA.data?.game_state).toEqual(asB.data?.game_state);

    const state = joinB.body.session.gameState as unknown as TicTacToeState;
    expect(state.board).toHaveLength(9);
    expect(state.board.every((cell) => cell === null)).toBe(true);
    expect(state.players).toHaveLength(2);
    expect([a.id, b.id]).toContain(state.currentTurn);
  });

  // -------------------------------------------------------------------------
  // Req 6.4 — a valid move reflects on both clients within 2 seconds
  // -------------------------------------------------------------------------
  it('reflects a valid move on the partner within 2 seconds (Req 6.4)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await activeSession(a, b);
    const state = session.gameState as unknown as TicTacToeState;

    // Subscribe the partner to the session channel BEFORE the move, so the
    // measurement covers fan-out rather than a late subscription.
    const captured = await listen(b.client, `rt_session:${session.id}`);

    const mover = state.currentTurn === a.id ? a : b;
    const started = Date.now();
    const moved = await callFunction<{ session: RTSessionView }>(
      config,
      'rt-move',
      { action: 'move', sessionId: session.id, move: { type: 'place', cell: 0, game: 'tic-tac-toe' } },
      mover.token,
    );
    expect(moved.status).toBe(200);

    const hit = await waitForEvent(captured, 'move', MOVE_BUDGET_MS);
    expect(hit).not.toBeNull();
    expect((hit as Captured).at - started).toBeLessThan(MOVE_BUDGET_MS);

    // The broadcast carries the authoritative post-move state, so the partner can
    // render without a round trip.
    const broadcastState = (hit as Captured).payload.gameState as TicTacToeState | undefined;
    expect(broadcastState?.board[0]).toBe(mover.id);

    // Turn alternated, so the same partner cannot immediately move again.
    const after = moved.body.session.gameState as unknown as TicTacToeState;
    expect(after.currentTurn).not.toBe(mover.id);
  });

  // -------------------------------------------------------------------------
  // Req 6.11 — an invalid move is rejected with state unchanged
  // -------------------------------------------------------------------------
  it('rejects invalid moves and leaves the board unchanged (Req 6.11)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await activeSession(a, b);
    const state = session.gameState as unknown as TicTacToeState;
    const mover = state.currentTurn === a.id ? a : b;
    const other = state.currentTurn === a.id ? b : a;

    // Establish one legitimate move so there is a non-trivial board to preserve.
    await callFunction(
      config,
      'rt-move',
      { action: 'move', sessionId: session.id, move: { type: 'place', cell: 0, game: 'tic-tac-toe' } },
      mover.token,
    );

    const before = await admin
      .from('rt_sessions')
      .select('game_state, updated_at')
      .eq('id', session.id)
      .single();

    // Three distinct ways to be invalid, all of which must be refused.
    const cases: { label: string; token: string; cell: number }[] = [
      // Out of turn: `mover` just played, so it is `other`'s turn now.
      { label: 'out of turn', token: mover.token, cell: 5 },
      // Occupied cell, by the partner whose turn it legitimately is.
      { label: 'occupied cell', token: other.token, cell: 0 },
      // Out of range.
      { label: 'out of range', token: other.token, cell: 99 },
    ];

    for (const { label, token, cell } of cases) {
      const res = await callFunction<FunctionErrorBody>(
        config,
        'rt-move',
        { action: 'move', sessionId: session.id, move: { type: 'place', cell, game: 'tic-tac-toe' } },
        token,
      );
      expect(res.status, label).toBe(400);
      expect(res.body.error?.code, label).toBe('INVALID_MOVE');
      // The rejection echoes the unchanged state so a client can resynchronise.
      expect(res.body.error?.details?.gameState, label).toBeDefined();
    }

    // Nothing was written at all — not the board, not even `updated_at`.
    const after = await admin
      .from('rt_sessions')
      .select('game_state, updated_at')
      .eq('id', session.id)
      .single();
    expect(after.data?.game_state).toEqual(before.data?.game_state);
    expect(after.data?.updated_at).toBe(before.data?.updated_at);
  });

  // -------------------------------------------------------------------------
  // Req 6.6 / 6.7 — Presence disconnect pauses; rejoin resumes
  // -------------------------------------------------------------------------
  it('pauses after 30s of disconnect and resumes from preserved state (Req 6.6, 6.7)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await activeSession(a, b);
    const state = session.gameState as unknown as TicTacToeState;
    const mover = state.currentTurn === a.id ? a : b;

    // Put a move on the board so "state preserved" is a real claim.
    await callFunction(
      config,
      'rt-move',
      { action: 'move', sessionId: session.id, move: { type: 'place', cell: 4, game: 'tic-tac-toe' } },
      mover.token,
    );
    const atPause = await admin
      .from('rt_sessions')
      .select('game_state')
      .eq('id', session.id)
      .single();

    const captured = await listen(a.client, `rt_session:${session.id}`);
    const now = Date.now();

    // Just SHORT of the threshold: no pause. This is what makes the test about
    // the 30-second rule rather than about "any absence pauses".
    const early = await callFunction<{ paused: boolean }>(
      config,
      'rt-presence',
      {
        sessionId: session.id,
        presence: [
          { accountId: a.id, online: true, lastSeenAt: now },
          { accountId: b.id, online: false, lastSeenAt: now - (DISCONNECT_THRESHOLD_MS - 1_000) },
        ],
      },
      a.token,
    );
    expect(early.status).toBe(200);
    expect(early.body.paused).toBe(false);

    let row = await admin.from('rt_sessions').select('state').eq('id', session.id).single();
    expect(row.data?.state).toBe('active');

    // Now past 30 continuous seconds: pause.
    const paused = await callFunction<{
      paused: boolean;
      disconnectedPartner: string;
      notifiedPartner: string;
      session: RTSessionView;
    }>(
      config,
      'rt-presence',
      {
        sessionId: session.id,
        presence: [
          { accountId: a.id, online: true, lastSeenAt: now },
          { accountId: b.id, online: false, lastSeenAt: now - (DISCONNECT_THRESHOLD_MS + 1_000) },
        ],
      },
      a.token,
    );
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    expect(paused.body.disconnectedPartner).toBe(b.id);
    // Req 6.6: the REMAINING partner is the one notified.
    expect(paused.body.notifiedPartner).toBe(a.id);

    row = await admin
      .from('rt_sessions')
      .select('state, paused_since, game_state')
      .eq('id', session.id)
      .single();
    expect(row.data?.state).toBe('paused');
    expect(row.data?.paused_since).not.toBeNull();
    // State preserved across the pause.
    expect(row.data?.game_state).toEqual(atPause.data?.game_state);

    // The remaining partner is told live as well as durably.
    expect(await waitForEvent(captured, 'paused', INVITE_BUDGET_MS)).not.toBeNull();
    const { data: notes } = await admin
      .from('notifications')
      .select('recipient_account_id, payload')
      .eq('recipient_account_id', a.id);
    expect(
      (notes ?? []).some((n) => JSON.stringify(n.payload).includes(session.id)),
    ).toBe(true);

    // Req 6.7: rejoin resumes from exactly the preserved state.
    const resumed = await callFunction<{ resumed: boolean; session: RTSessionView }>(
      config,
      'rt-rejoin',
      { sessionId: session.id },
      b.token,
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.session.state).toBe('active');

    const afterRejoin = await admin
      .from('rt_sessions')
      .select('state, game_state')
      .eq('id', session.id)
      .single();
    expect(afterRejoin.data?.state).toBe('active');
    expect(afterRejoin.data?.game_state).toEqual(atPause.data?.game_state);

    expect(await waitForEvent(captured, 'resumed', INVITE_BUDGET_MS)).not.toBeNull();
  });

  it('ignores a presence report from outside the pairing', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);
    const session = await activeSession(a, b);

    // An outsider claiming both partners are absent must not be able to pause
    // someone else's game.
    const outsiderA = await member();
    const outsiderB = await member();
    await pair(outsiderA.token, outsiderB.token);

    const now = Date.now();
    const res = await callFunction<FunctionErrorBody & { paused?: boolean }>(
      config,
      'rt-presence',
      {
        sessionId: session.id,
        presence: [
          { accountId: a.id, online: false, lastSeenAt: now - 60_000 },
          { accountId: b.id, online: false, lastSeenAt: now - 60_000 },
        ],
      },
      outsiderA.token,
    );

    // Reported as not-found rather than forbidden, so another pairing's sessions
    // are not probeable.
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('SESSION_NOT_FOUND');

    const row = await admin.from('rt_sessions').select('state').eq('id', session.id).single();
    expect(row.data?.state).toBe('active');
  });
});
