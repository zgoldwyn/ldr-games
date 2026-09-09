import type { SupabaseClient } from '@supabase/supabase-js';

import { TURN_NUDGE_THRESHOLD_MS } from '../domain/async-lifecycle.js';
import { NOTIFICATION_RETENTION_MS } from '../domain/notification-delivery.js';
import { JOIN_WINDOW_MS, REJOIN_WINDOW_MS } from '../domain/rt-session.js';
import { INACTIVITY_LIMIT_MS } from '../domain/session-epoch.js';
import {
  createPairing,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  getIntegrationConfig,
  signIn,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration tests for the game-related scheduler jobs (task 20.3, Req 6.9,
// 6.10, 7.12), implemented as plpgsql invoked by pg_cron in migration
// 20260901000003.
//
// TWO THINGS THESE TESTS DO THAT MATTER MORE THAN THE HAPPY PATH:
//
// 1. They BRACKET each window — probing at `threshold - 1s` (must not fire) and
//    `threshold + 1s` (must fire). Without the lower probe a test only proves
//    "some elapsed time triggers it", which would pass against a threshold of
//    zero and would not catch a unit mix-up (seconds vs minutes vs hours).
//
// 2. They import the TypeScript threshold constants and derive the probe instants
//    FROM them. The windows exist in two places now — TS constants and SQL
//    intervals — which is the acknowledged cost of implementing the jobs in the
//    database. Deriving the probes from the TS side means a divergence between the
//    two fails here instead of going unnoticed.
//
// Each function takes `p_now`, so these run in milliseconds against synthetic
// instants rather than waiting out a real 60s / 5min / 48h window. That is the
// whole reason the jobs are plain SQL rather than cron-invoked Edge Functions —
// Req 7.12's 48-hour nudge is otherwise not practically testable.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

/** A fixed base instant; every probe is computed relative to this. */
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
/** Future relative to real cron, so synthetic boundary rows cannot race it. */
const FUTURE_BASE = Date.UTC(2035, 0, 1, 0, 0, 0);

const iso = (ms: number): string => new Date(ms).toISOString();

describe.skipIf(cfg === null)('Game scheduler jobs (integration)', () => {
  const config = cfg as IntegrationConfig;
  let admin: SupabaseClient;
  const created: string[] = [];

  /** Two fresh accounts in an active pairing. */
  async function pairedAccounts(): Promise<{
    a: TestAccount;
    b: TestAccount;
    pairing: string;
  }> {
    const a = await createTestAccount(admin);
    const b = await createTestAccount(admin);
    created.push(a.id, b.id);
    const pairing = await createPairing(admin, a.id, b.id);
    return { a, b, pairing };
  }

  /** Invoke a scheduler function with a synthetic `now`, returning session ids. */
  async function runJob(fn: string, nowMs: number): Promise<string[]> {
    const { data, error } = await admin.rpc(fn, { p_now: iso(nowMs) });
    expect(error, `${fn} failed: ${error?.message}`).toBeNull();
    // `returns setof uuid` comes back as an array of ids (or [] when nothing matched).
    if (data === null) return [];
    return (Array.isArray(data) ? data : [data]) as string[];
  }

  async function notificationsFor(accountIds: readonly string[], keyPrefix: string) {
    const { data, error } = await admin
      .from('notifications')
      .select('recipient_account_id, category, payload, dedupe_key, delivered_at')
      .in('recipient_account_id', [...accountIds])
      .like('dedupe_key', `${keyPrefix}%`);
    expect(error).toBeNull();
    return data ?? [];
  }

  beforeAll(() => {
    admin = createServiceClient(config);
  });

  afterAll(async () => {
    await Promise.all(created.map((id) => deleteTestAccount(admin, id).catch(() => undefined)));
  });

  // -------------------------------------------------------------------------
  // The schedules themselves
  // -------------------------------------------------------------------------
  it('has all six cron jobs scheduled and active', async () => {
    // A correct function that is never scheduled is still a broken feature, so the
    // schedule is asserted separately from the behaviour. `cron.job` is not exposed
    // by the Data API, which is why migration 20260901000003 adds the
    // `ldr_scheduled_jobs` inspection function — without it this could only be
    // checked by shelling into the database container.
    const { data, error } = await admin.rpc('ldr_scheduled_jobs');
    expect(error, `ldr_scheduled_jobs failed: ${error?.message}`).toBeNull();

    const jobs = (data ?? []) as {
      job_name: string;
      job_schedule: string;
      job_active: boolean;
    }[];
    const byName = new Map(jobs.map((j) => [j.job_name, j]));

    for (const name of [
      'ldr-rt-join-expiry',
      'ldr-rt-pause-termination',
      'ldr-async-turn-nudge',
      'ldr-reminder-delivery',
      'ldr-session-inactivity',
      'ldr-notification-retention',
    ]) {
      const job = byName.get(name);
      expect(job, `${name} is not scheduled`).toBeDefined();
      expect(job?.job_active, `${name} is scheduled but disabled`).toBe(true);
    }

    // The join-expiry job must run at sub-minute cadence: its deadline is 60s, so a
    // once-a-minute schedule could leave a cancelled invitation unobserved for
    // nearly two minutes.
    expect(byName.get('ldr-rt-join-expiry')?.job_schedule).toBe('30 seconds');
  });

  // -------------------------------------------------------------------------
  // Requirement 6.9 — 60s join expiry
  // -------------------------------------------------------------------------
  it('cancels a pending session only after the 60s join window (Req 6.9)', async () => {
    const { a, b, pairing } = await pairedAccounts();

    // `joined_accounts: [a.id]` mirrors what rt-move's invite action writes, which
    // is how the job knows A is the INVITER.
    const seeded = await admin
      .from('rt_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'tic-tac-toe',
        state: 'pending',
        pending_since: iso(BASE),
        joined_accounts: [a.id],
      })
      .select('id')
      .single();
    expect(seeded.error).toBeNull();
    const sessionId = seeded.data?.id as string;

    // Lower bracket: one second inside the window, nothing happens.
    const inside = await runJob('expire_pending_rt_sessions', BASE + JOIN_WINDOW_MS - 1_000);
    expect(inside).not.toContain(sessionId);
    let row = await admin.from('rt_sessions').select('state').eq('id', sessionId).single();
    expect(row.data?.state).toBe('pending');

    // Upper bracket: one second past it, the session is cancelled.
    const past = await runJob('expire_pending_rt_sessions', BASE + JOIN_WINDOW_MS + 1_000);
    expect(past).toContain(sessionId);

    row = await admin
      .from('rt_sessions')
      .select('state, outcome, pending_since')
      .eq('id', sessionId)
      .single();
    expect(row.data?.state).toBe('terminal');
    expect(row.data?.outcome).toMatchObject({
      kind: 'ended_without_outcome',
      reason: 'invitation_expired',
      winner: null,
    });
    // The deadline is cleared, so the row cannot be re-processed.
    expect(row.data?.pending_since).toBeNull();

    // Req 6.9 names the INVITING partner as the recipient — only A, not both.
    const notes = await notificationsFor([a.id, b.id], 'rt:invite_expired:');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.recipient_account_id).toBe(a.id);
    expect(notes[0]?.category).toBe('game_invite');
    expect((notes[0]?.payload as { kind?: string })?.kind).toBe('rt_invite_expired');
    // Undelivered, so an offline inviter learns on next sign-in.
    expect(notes[0]?.delivered_at).toBeNull();

    // Running again is a no-op: already terminal, and the dedupe key holds.
    const again = await runJob('expire_pending_rt_sessions', BASE + 60 * 60 * 1000);
    expect(again).not.toContain(sessionId);
    expect(await notificationsFor([a.id, b.id], 'rt:invite_expired:')).toHaveLength(1);
  });

  it('leaves an active session alone however old it is (Req 6.9)', async () => {
    const { a, pairing } = await pairedAccounts();

    // Both partners joined, so the join window is irrelevant. An expiry job that
    // keyed off age rather than STATE would wrongly kill a game in progress.
    const seeded = await admin
      .from('rt_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'tic-tac-toe',
        state: 'active',
        pending_since: null,
        joined_accounts: [a.id],
      })
      .select('id')
      .single();
    const sessionId = seeded.data?.id as string;

    const ran = await runJob('expire_pending_rt_sessions', BASE + 365 * 24 * 60 * 60 * 1000);
    expect(ran).not.toContain(sessionId);
    const row = await admin.from('rt_sessions').select('state').eq('id', sessionId).single();
    expect(row.data?.state).toBe('active');
  });

  // -------------------------------------------------------------------------
  // Requirement 6.10 — 5-minute pause termination
  // -------------------------------------------------------------------------
  it('terminates an abandoned pause only after 5 minutes, notifying both (Req 6.10)', async () => {
    const { a, b, pairing } = await pairedAccounts();

    const board = { game: 'tic-tac-toe', board: [a.id, null, null] };
    const seeded = await admin
      .from('rt_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'tic-tac-toe',
        state: 'paused',
        paused_since: iso(BASE),
        game_state: board,
      })
      .select('id')
      .single();
    expect(seeded.error).toBeNull();
    const sessionId = seeded.data?.id as string;

    const inside = await runJob('terminate_abandoned_rt_pauses', BASE + REJOIN_WINDOW_MS - 1_000);
    expect(inside).not.toContain(sessionId);
    let row = await admin.from('rt_sessions').select('state').eq('id', sessionId).single();
    expect(row.data?.state).toBe('paused');

    const past = await runJob('terminate_abandoned_rt_pauses', BASE + REJOIN_WINDOW_MS + 1_000);
    expect(past).toContain(sessionId);

    row = await admin
      .from('rt_sessions')
      .select('state, outcome, paused_since, game_state')
      .eq('id', sessionId)
      .single();
    expect(row.data?.state).toBe('terminal');
    // Req 6.10: recorded as ended WITHOUT a completed outcome, and distinguishable
    // from an expired invitation.
    expect(row.data?.outcome).toMatchObject({
      kind: 'ended_without_outcome',
      reason: 'rejoin_window_expired',
      winner: null,
    });
    // The final board is preserved — terminating the session must not erase what
    // was played.
    expect(row.data?.game_state).toEqual(board);

    // Req 6.10 notifies BOTH partners, unlike 6.9.
    const notes = await notificationsFor([a.id, b.id], 'rt:pause_expired:');
    expect(new Set(notes.map((n) => n.recipient_account_id))).toEqual(new Set([a.id, b.id]));
    for (const note of notes) {
      expect(note.delivered_at).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Requirement 7.12 — 48-hour nudge that must NOT forfeit
  // -------------------------------------------------------------------------
  it('nudges a 48h-pending turn WITHOUT terminating the session (Req 7.12, 7.11)', async () => {
    const { a, b, pairing } = await pairedAccounts();

    const seeded = await admin
      .from('async_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'battleship',
        state: 'active',
        active_turn_holder: b.id,
        turn_pending_since: iso(BASE),
        game_state: { turns: [] },
      })
      .select('id')
      .single();
    expect(seeded.error).toBeNull();
    const sessionId = seeded.data?.id as string;

    const inside = await runJob(
      'nudge_stale_async_turns',
      BASE + TURN_NUDGE_THRESHOLD_MS - 1_000,
    );
    expect(inside).not.toContain(sessionId);
    expect(await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:')).toHaveLength(0);

    const past = await runJob('nudge_stale_async_turns', BASE + TURN_NUDGE_THRESHOLD_MS + 1_000);
    expect(past).toContain(sessionId);

    // THE central assertion of Req 7.12: the nudge must not terminate or forfeit.
    // Req 7.11 says inactivity never ends an asynchronous session, so the state,
    // the holder and the outcome must all be untouched.
    const row = await admin
      .from('async_sessions')
      .select('state, outcome, active_turn_holder, turn_pending_since')
      .eq('id', sessionId)
      .single();
    expect(row.data?.state).toBe('active');
    expect(row.data?.outcome).toBeNull();
    expect(row.data?.active_turn_holder).toBe(b.id);
    // The pending stamp is untouched too — moving it would silently restart the
    // window and suppress every later nudge.
    expect(Date.parse(row.data?.turn_pending_since as string)).toBe(BASE);

    // Addressed to the Active_Turn_Holder, not the partner waiting on them.
    const notes = await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.recipient_account_id).toBe(b.id);
    expect(notes[0]?.category).toBe('async_turn');
    expect((notes[0]?.payload as { kind?: string })?.kind).toBe('turn_reminder');

    // The dedupe key must match `deriveTurnNudge`'s format EXACTLY, or a nudge
    // derived in TypeScript and one derived in SQL would double-notify (Req 11.6).
    expect(notes[0]?.dedupe_key).toBe(`async_turn:turn_reminder:${sessionId}:${BASE}`);

    // Req 11.6: running repeatedly does not duplicate the reminder for the same
    // pending turn.
    await runJob('nudge_stale_async_turns', BASE + TURN_NUDGE_THRESHOLD_MS + 60_000);
    await runJob('nudge_stale_async_turns', BASE + 10 * TURN_NUDGE_THRESHOLD_MS);
    expect(await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:')).toHaveLength(1);
  });

  it('nudges again once the turn changes hands (Req 7.12, 11.6)', async () => {
    const { a, b, pairing } = await pairedAccounts();

    const seeded = await admin
      .from('async_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'battleship',
        state: 'active',
        active_turn_holder: b.id,
        turn_pending_since: iso(BASE),
        game_state: { turns: [] },
      })
      .select('id')
      .single();
    const sessionId = seeded.data?.id as string;

    await runJob('nudge_stale_async_turns', BASE + TURN_NUDGE_THRESHOLD_MS + 1_000);
    expect(await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:')).toHaveLength(1);

    // A turn is taken: holder flips and the pending stamp is refreshed, exactly as
    // async_take_turn does. The dedupe key is keyed on that stamp, so the NEXT
    // stale turn is a distinct notification rather than being suppressed forever.
    const secondTurnAt = BASE + TURN_NUDGE_THRESHOLD_MS + 2_000;
    await admin
      .from('async_sessions')
      .update({ active_turn_holder: a.id, turn_pending_since: iso(secondTurnAt) })
      .eq('id', sessionId);

    await runJob('nudge_stale_async_turns', secondTurnAt + TURN_NUDGE_THRESHOLD_MS + 1_000);
    const notes = await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:');
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((n) => n.recipient_account_id))).toEqual(new Set([a.id, b.id]));
  });

  it('does not nudge a terminal session (Req 7.12)', async () => {
    const { a, b, pairing } = await pairedAccounts();

    const seeded = await admin
      .from('async_sessions')
      .insert({
        pairing_id: pairing,
        game_id: 'battleship',
        state: 'terminal',
        active_turn_holder: b.id,
        turn_pending_since: iso(BASE),
        outcome: { kind: 'completed', winner: a.id },
        game_state: { turns: [] },
      })
      .select('id')
      .single();
    const sessionId = seeded.data?.id as string;

    const ran = await runJob('nudge_stale_async_turns', BASE + 10 * TURN_NUDGE_THRESHOLD_MS);
    expect(ran).not.toContain(sessionId);
    expect(await notificationsFor([a.id, b.id], 'async_turn:turn_reminder:')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Requirement 10.3 — due reminder delivery within the minute cadence
  // -------------------------------------------------------------------------
  it('delivers a due reminder to both partners once and advances it (Req 10.3)', async () => {
    const { a, b, pairing } = await pairedAccounts();
    const date = await admin
      .from('relationship_dates')
      .insert({
        pairing_id: pairing,
        title: 'Our day',
        date: '2035-01-02',
        recurring: false,
      })
      .select('id')
      .single();
    expect(date.error).toBeNull();

    const triggerAt = FUTURE_BASE + 60_000;
    const reminder = await admin
      .from('reminders')
      .insert({
        date_id: date.data?.id,
        pairing_id: pairing,
        lead_time_ms: 60_000,
        next_trigger_at: iso(triggerAt),
        status: 'scheduled',
      })
      .select('id')
      .single();
    expect(reminder.error).toBeNull();
    const reminderId = reminder.data?.id as string;

    expect(await runJob('deliver_due_calendar_reminders', triggerAt - 1)).not.toContain(
      reminderId,
    );
    expect(await notificationsFor([a.id, b.id], `reminder:${reminderId}:`)).toHaveLength(0);

    expect(await runJob('deliver_due_calendar_reminders', triggerAt)).toContain(reminderId);
    const notes = await notificationsFor([a.id, b.id], `reminder:${reminderId}:`);
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((note) => note.recipient_account_id))).toEqual(
      new Set([a.id, b.id]),
    );
    expect(notes.every((note) => note.category === 'reminder')).toBe(true);
    expect(notes.every((note) => note.delivered_at === null)).toBe(true);

    const advanced = await admin.from('reminders').select('status').eq('id', reminderId).single();
    expect(advanced.data?.status).toBe('delivered');
    expect(await runJob('deliver_due_calendar_reminders', triggerAt + 60_000)).not.toContain(
      reminderId,
    );
    expect(await notificationsFor([a.id, b.id], `reminder:${reminderId}:`)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Requirement 2.6 — 30-day inactivity revocation
  // -------------------------------------------------------------------------
  it('revokes a session exactly at 30 days and cannot repeat (Req 2.6)', async () => {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const client = await signIn(config, account);
    const protectedRow = await admin
      .from('notifications')
      .insert({
        recipient_account_id: account.id,
        category: 'system',
        payload: {},
        dedupe_key: 'inactivity-probe',
        created_at: iso(FUTURE_BASE),
      })
      .select('id')
      .single();
    expect(protectedRow.error).toBeNull();

    await admin
      .from('account_session')
      .update({ last_activity_at: iso(FUTURE_BASE), expired_at: null })
      .eq('account_id', account.id);

    const inside = await runJob(
      'expire_inactive_account_sessions',
      FUTURE_BASE + INACTIVITY_LIMIT_MS - 1,
    );
    expect(inside).not.toContain(account.id);
    expect((await client.from('notifications').select('id')).data).toHaveLength(1);

    const expired = await runJob(
      'expire_inactive_account_sessions',
      FUTURE_BASE + INACTIVITY_LIMIT_MS,
    );
    expect(expired).toContain(account.id);
    const registry = await admin
      .from('account_session')
      .select('epoch, expired_at')
      .eq('account_id', account.id)
      .single();
    expect(registry.data?.epoch).toBe(1);
    expect(Date.parse(registry.data?.expired_at as string)).toBe(
      FUTURE_BASE + INACTIVITY_LIMIT_MS,
    );

    // The still-signed access token is denied by the registry marker, and the
    // GoTrue session deletion prevents its refresh token from reviving it.
    expect((await client.from('notifications').select('id')).data).toEqual([]);
    expect((await client.auth.refreshSession()).error).not.toBeNull();
    expect(
      await runJob('expire_inactive_account_sessions', FUTURE_BASE + 2 * INACTIVITY_LIMIT_MS),
    ).not.toContain(account.id);
  });

  // -------------------------------------------------------------------------
  // Requirement 11.5 — strict 30-day retention boundary
  // -------------------------------------------------------------------------
  it('discards only notifications strictly older than 30 days (Req 11.4, 11.5)', async () => {
    const account = await createTestAccount(admin);
    created.push(account.id);
    const now = FUTURE_BASE + 2 * NOTIFICATION_RETENTION_MS;
    const seeded = await admin
      .from('notifications')
      .insert([
        {
          recipient_account_id: account.id,
          category: 'system',
          payload: {},
          dedupe_key: 'retention-inside',
          created_at: iso(now - NOTIFICATION_RETENTION_MS + 1),
        },
        {
          recipient_account_id: account.id,
          category: 'system',
          payload: {},
          dedupe_key: 'retention-boundary',
          created_at: iso(now - NOTIFICATION_RETENTION_MS),
        },
        {
          recipient_account_id: account.id,
          category: 'system',
          payload: {},
          dedupe_key: 'retention-expired',
          created_at: iso(now - NOTIFICATION_RETENTION_MS - 1),
        },
      ])
      .select('id, dedupe_key');
    expect(seeded.error).toBeNull();
    const byKey = new Map((seeded.data ?? []).map((row) => [row.dedupe_key, row.id]));

    const discarded = await runJob('discard_expired_notifications', now);
    expect(discarded).toContain(byKey.get('retention-expired'));
    expect(discarded).not.toContain(byKey.get('retention-inside'));
    expect(discarded).not.toContain(byKey.get('retention-boundary'));
    const retained = await admin
      .from('notifications')
      .select('dedupe_key')
      .eq('recipient_account_id', account.id)
      .like('dedupe_key', 'retention-%');
    expect(new Set((retained.data ?? []).map((row) => row.dedupe_key))).toEqual(
      new Set(['retention-inside', 'retention-boundary']),
    );
  });
});
