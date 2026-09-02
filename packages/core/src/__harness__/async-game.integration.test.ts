import type { SupabaseClient } from '@supabase/supabase-js';

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

// Integration tests for the asynchronous game wiring (task 16.3): the
// `async-start` and `async-take-turn` Edge Functions (16.1).
//
//   Req 7.2   a session designates an initial Active_Turn_Holder
//   Req 7.3   play progresses with only one partner online
//   Req 7.5   a valid turn transfers the Active_Turn_Holder
//   Req 7.6   the new holder is notified it is their turn
//   Req 7.7   a non-holder's turn is rejected, state and holder unchanged
//   Req 7.8   an invalid turn is rejected, state unchanged
//   Req 7.9   starting without a pairing is refused
//   Req 7.10  a terminal outcome is recorded and delivered to BOTH partners,
//             deferred for one without a current session
//   Req 7.11  inactivity never terminates or forfeits a session
//
// Battleship is used because it is the ruleset that can reach a terminal state:
// a partner wins by hitting every cell of the opponent's fleet. Tests give each
// partner a single-cell fleet on a small board so a game can be driven to
// terminal in one shot rather than by exhaustive firing.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** Req 7.6 notification budget. */
const NOTIFY_BUDGET_MS = 5_000;

interface AsyncSessionView {
  readonly id: string;
  readonly pairingId: string;
  readonly gameId: string;
  readonly state: 'active' | 'terminal';
  readonly activeTurnHolder: string;
  readonly turnPendingSince: number;
  readonly gameState: {
    readonly turns: readonly { readonly seq: number; readonly actor: string }[];
    readonly ruleset: Record<string, unknown>;
    readonly winner: string | null;
    readonly status: string;
  };
  readonly outcome?: { readonly kind: string; readonly winner: string | null } | null;
}

describe.skipIf(cfg === null)('Asynchronous game wiring (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

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
   * Start a battleship session where each partner has a single-cell fleet, so one
   * accurate shot ends the game. `a` is the initiator and supplies both fleets
   * (there is no separate placement endpoint).
   */
  async function startBattleship(
    a: { id: string; token: string },
    b: { id: string },
  ): Promise<AsyncSessionView> {
    const started = await callFunction<{ session: AsyncSessionView }>(
      config,
      'async-start',
      {
        gameId: 'battleship',
        options: {
          size: 3,
          ships: { [a.id]: [{ row: 0, col: 0 }], [b.id]: [{ row: 1, col: 1 }] },
        },
      },
      a.token,
    );
    expect(started.status).toBe(201);
    return started.body.session;
  }

  /** The cell holding `accountId`'s single-cell fleet, i.e. what to shoot at. */
  function fleetCellOf(accountId: string, a: { id: string }): { row: number; col: number } {
    return accountId === a.id ? { row: 0, col: 0 } : { row: 1, col: 1 };
  }

  async function fire(
    token: string,
    sessionId: string,
    cell: { row: number; col: number },
  ) {
    return await callFunction<{ session: AsyncSessionView } & FunctionErrorBody>(
      config,
      'async-take-turn',
      { sessionId, action: { kind: 'battleship.fire', ...cell } },
      token,
    );
  }

  async function sessionRow(id: string) {
    const { data, error } = await admin
      .from('async_sessions')
      .select('state, active_turn_holder, game_state, outcome, turn_pending_since')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return data;
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
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  // -------------------------------------------------------------------------
  // Req 7.2 / 7.9 — session creation
  // -------------------------------------------------------------------------
  it('designates an initial turn holder and refuses an unpaired account (Req 7.2, 7.9)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    expect(session.state).toBe('active');
    // Req 7.2: a holder is designated up front, per the game's rules.
    expect([a.id, b.id]).toContain(session.activeTurnHolder);
    expect(session.gameState.turns).toHaveLength(0);

    // The partner is told a game was started (Req 7.2).
    const { data } = await admin
      .from('notifications')
      .select('category, payload')
      .eq('recipient_account_id', b.id);
    expect(
      (data ?? []).some(
        (n) => (n.payload as { kind?: string })?.kind === 'async_game_invite',
      ),
    ).toBe(true);

    // Req 7.9: no partner, no session.
    const lonely = await member();
    const refused = await callFunction<FunctionErrorBody>(
      config,
      'async-start',
      { gameId: 'battleship' },
      lonely.token,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('PAIRING_REQUIRED');
  });

  it('refuses a battleship start with an empty fleet, which could never end', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    // The ruleset derives "all sunk" from the opponent's ship cells, so a fleet of
    // zero cells can never be fully hit and the session could never reach a
    // terminal state (Req 7.10).
    const refused = await callFunction<FunctionErrorBody>(
      config,
      'async-start',
      { gameId: 'battleship' },
      a.token,
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('INVALID_TURN');

    // One-sided placement is refused too.
    const oneSided = await callFunction<FunctionErrorBody>(
      config,
      'async-start',
      { gameId: 'battleship', options: { ships: { [a.id]: [{ row: 0, col: 0 }] } } },
      a.token,
    );
    expect(oneSided.status).toBe(400);

    // Nothing was created by either rejected attempt.
    const { data } = await admin
      .from('async_sessions')
      .select('id')
      .eq('pairing_id', (await admin.from('accounts').select('pairing_id').eq('id', a.id).single()).data?.pairing_id);
    expect(data ?? []).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Req 7.7 / 7.8 — rejections leave state untouched
  // -------------------------------------------------------------------------
  it("rejects a non-holder's turn and an invalid turn, state unchanged (Req 7.7, 7.8)", async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    const holder = session.activeTurnHolder === a.id ? a : b;
    const nonHolder = session.activeTurnHolder === a.id ? b : a;

    const before = await sessionRow(session.id);

    // Req 7.7: the wrong partner cannot take the turn.
    const wrongPartner = await fire(nonHolder.token, session.id, { row: 2, col: 2 });
    expect(wrongPartner.status).toBe(409);
    expect(wrongPartner.body.error?.code).toBe('NOT_YOUR_TURN');

    // Req 7.8: the right partner, but an illegal shot.
    const outOfRange = await fire(holder.token, session.id, { row: 99, col: 0 });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.error?.code).toBe('INVALID_TURN');

    // Both rejections wrote nothing at all: same state, same holder, and the same
    // pending stamp (so the 48h nudge window was not silently restarted either).
    const after = await sessionRow(session.id);
    expect(after?.game_state).toEqual(before?.game_state);
    expect(after?.active_turn_holder).toBe(before?.active_turn_holder);
    expect(after?.turn_pending_since).toBe(before?.turn_pending_since);
    expect((after?.game_state as { turns?: unknown[] })?.turns).toHaveLength(0);
  });

  it('rejects firing at the same coordinate twice (Req 7.8)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    const first = session.activeTurnHolder === a.id ? a : b;
    const second = session.activeTurnHolder === a.id ? b : a;

    // A deliberate miss, so the game continues and the turn comes back around.
    const miss = await fire(first.token, session.id, { row: 2, col: 2 });
    expect(miss.status).toBe(200);
    const back = await fire(second.token, session.id, { row: 2, col: 0 });
    expect(back.status).toBe(200);

    // Re-firing an already-used coordinate is invalid for that partner.
    const repeat = await fire(first.token, session.id, { row: 2, col: 2 });
    expect(repeat.status).toBe(400);
    expect(repeat.body.error?.code).toBe('INVALID_TURN');

    const row = await sessionRow(session.id);
    expect((row?.game_state as { turns: unknown[] }).turns).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Req 7.5 / 7.6 — a valid turn transfers ownership and notifies
  // -------------------------------------------------------------------------
  it('transfers the turn holder and notifies the partner (Req 7.5, 7.6)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    const holder = session.activeTurnHolder === a.id ? a : b;
    const partner = session.activeTurnHolder === a.id ? b : a;

    const started = Date.now();
    // A miss, so the session stays active and only the hand-off is under test.
    const moved = await fire(holder.token, session.id, { row: 2, col: 2 });
    expect(moved.status).toBe(200);

    // Req 7.5: the turn is recorded and ownership transfers, so the same partner
    // cannot take a second consecutive turn.
    expect(moved.body.session.activeTurnHolder).toBe(partner.id);
    expect(moved.body.session.gameState.turns).toHaveLength(1);
    expect(moved.body.session.gameState.turns[0]?.actor).toBe(holder.id);

    const again = await fire(holder.token, session.id, { row: 0, col: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('NOT_YOUR_TURN');

    // Req 7.6: the NEW holder is notified it is their turn, durably (delivered_at
    // NULL) so an offline partner receives it on next sign-in.
    const deadline = started + NOTIFY_BUDGET_MS;
    let yourTurn: { delivered_at: string | null } | undefined;
    while (Date.now() < deadline && yourTurn === undefined) {
      const { data } = await admin
        .from('notifications')
        .select('recipient_account_id, category, payload, delivered_at')
        .eq('recipient_account_id', partner.id);
      yourTurn = (data ?? []).find(
        (n) => (n.payload as { kind?: string })?.kind === 'your_turn',
      ) as { delivered_at: string | null } | undefined;
      if (yourTurn === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    expect(yourTurn).toBeDefined();
    expect(yourTurn?.delivered_at).toBeNull();

    // The turn-pending stamp was refreshed, which is what restarts the 48h nudge
    // window for the new holder (Req 7.12).
    const row = await sessionRow(session.id);
    expect(Date.parse(row?.turn_pending_since as string)).toBeGreaterThanOrEqual(
      session.turnPendingSince,
    );
  });

  // -------------------------------------------------------------------------
  // Req 7.3 / 7.11 — progresses offline; inactivity never ends a session
  // -------------------------------------------------------------------------
  it('progresses with one partner absent and survives long inactivity (Req 7.3, 7.11)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    const holder = session.activeTurnHolder === a.id ? a : b;
    const partner = session.activeTurnHolder === a.id ? b : a;

    // Req 7.3: the partner has no live connection of any kind here — no channel,
    // no presence — and the turn still applies, because the whole game lives in
    // Postgres.
    const moved = await fire(holder.token, session.id, { row: 2, col: 2 });
    expect(moved.status).toBe(200);
    expect(moved.body.session.activeTurnHolder).toBe(partner.id);

    // Req 7.11: age the pending turn far beyond any threshold. The session must
    // remain active — inactivity never forfeits or terminates it.
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await admin
      .from('async_sessions')
      .update({ turn_pending_since: longAgo })
      .eq('id', session.id);

    const aged = await sessionRow(session.id);
    expect(aged?.state).toBe('active');
    expect(aged?.outcome).toBeNull();

    // And the long-pending turn is still playable.
    const resumed = await fire(partner.token, session.id, { row: 0, col: 2 });
    expect(resumed.status).toBe(200);
    expect(resumed.body.session.state).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Req 7.10 — terminal outcome recorded and delivered to both partners
  // -------------------------------------------------------------------------
  it('records a terminal outcome and defers delivery to an offline partner (Req 7.10)', async () => {
    const a = await member();
    const b = await member();
    await pair(a.token, b.token);

    const session = await startBattleship(a, b);
    const holder = session.activeTurnHolder === a.id ? a : b;
    const loser = session.activeTurnHolder === a.id ? b : a;

    // The partner who is about to LOSE signs out first, so the outcome has to be
    // waiting for them rather than pushed live (Req 7.10's deferral clause).
    await loser.client.auth.signOut();

    // One accurate shot sinks the opponent's single-cell fleet.
    const finished = await fire(holder.token, session.id, fleetCellOf(loser.id, a));
    expect(finished.status).toBe(200);
    expect(finished.body.session.state).toBe('terminal');
    expect(finished.body.session.outcome).toMatchObject({
      kind: 'completed',
      winner: holder.id,
    });

    const row = await sessionRow(session.id);
    expect(row?.state).toBe('terminal');
    expect(row?.outcome).toMatchObject({ kind: 'completed', winner: holder.id });

    // The result is addressed to BOTH partners, undelivered, so the signed-out
    // partner receives it on next sign-in.
    const { data } = await admin
      .from('notifications')
      .select('recipient_account_id, payload, delivered_at')
      .in('recipient_account_id', [a.id, b.id]);
    const results = (data ?? []).filter(
      (n) => (n.payload as { kind?: string })?.kind === 'session_result',
    );
    expect(new Set(results.map((n) => n.recipient_account_id))).toEqual(
      new Set([a.id, b.id]),
    );
    for (const note of results) {
      expect(note.delivered_at).toBeNull();
    }

    // Signing back in, the former partner can read the recorded outcome — this is
    // what "delivered when that partner next establishes a session" means.
    const reborn = await signIn(config, loser.account);
    const view = await reborn
      .from('async_sessions')
      .select('state, outcome')
      .eq('id', session.id)
      .single();
    expect(view.error).toBeNull();
    expect(view.data?.state).toBe('terminal');
    expect(view.data?.outcome).toMatchObject({ winner: holder.id });

    // A terminal session accepts no further turns. Uses the token from the FRESH
    // sign-in above: reusing the signed-out token would return 401 and prove only
    // that sign-out works, not that a finished game is closed.
    const { data: rebornSession } = await reborn.auth.getSession();
    const rebornToken = rebornSession.session?.access_token;
    expect(rebornToken).toBeDefined();

    const afterEnd = await fire(rebornToken as string, session.id, { row: 2, col: 2 });
    expect([400, 409]).toContain(afterEnd.status);
    const unchanged = await sessionRow(session.id);
    expect(unchanged?.state).toBe('terminal');
    expect(unchanged?.outcome).toMatchObject({ winner: holder.id });
  });
});
