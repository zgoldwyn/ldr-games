import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createCalendarModule, type CalendarModule } from '../calendar/calendar-module.js';
import { createSupabaseCalendarPorts } from '../calendar/supabase-ports.js';
import {
  dateId,
  MAX_LEAD_TIME,
  MIN_LEAD_TIME,
  pairingId,
  reminderTriggerTime,
  type CalendarDate,
  type RelationshipDate,
} from '../domain/index.js';
import {
  callFunction,
  createServiceClient,
  createTestAccount,
  deleteTestAccount,
  functionsRuntimeReachable,
  getIntegrationConfig,
  signIn,
  withRealtimeRetry,
  type FunctionErrorBody,
  type FunctionResponse,
  type IntegrationConfig,
  type TestAccount,
} from './supabase.js';

// Integration coverage for task 18.1 / Requirements 9.1–9.7.
//
// Mutations go through the authenticated `calendar` Edge Function.  There is
// deliberately no service-role write in this file: the function is the
// server-authoritative validation and pairing-scope boundary.  Reads used for
// assertions go through the caller's RLS-scoped client, and the Realtime check
// listens on the same caller-scoped client that a platform shell would use.
//
// The module and ports are used for normal caller behavior below. The direct
// Edge-Function helpers remain for malformed-input probes, so client-side
// validation cannot short-circuit proof that the server rejects bad writes.
//
// Run with: npm run test:integration:local

const cfg = getIntegrationConfig();

const PROPAGATION_BUDGET_MS = 5_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

interface CalendarDateRow {
  readonly id: string;
  readonly pairing_id: string;
  readonly title: string;
  readonly date: string;
  readonly recurring: boolean;
}

interface CalendarMutationBody {
  readonly date?: CalendarDateRow;
  readonly reminder?: {
    readonly id: string;
    readonly dateId: string;
    readonly pairingId: string;
    readonly leadTime: number;
    readonly nextTriggerAt: string;
    readonly status: string;
  };
  readonly error?: FunctionErrorBody['error'];
}

interface ReminderRow {
  readonly id: string;
  readonly date_id: string;
  readonly pairing_id: string;
  readonly lead_time_ms: number;
  readonly next_trigger_at: string;
  readonly status: string;
}

describe.skipIf(cfg === null)('Calendar date writes (integration)', () => {
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

  async function pair(aToken: string, bToken: string): Promise<string> {
    const invitation = await callFunction<{ invitation: { code: string } }>(
      config,
      'create-invitation',
      {},
      aToken,
    );
    expect(invitation.status).toBe(201);
    const accepted = await callFunction<{ pairing: { id: string } }>(
      config,
      'accept-invitation',
      { code: invitation.body.invitation.code },
      bToken,
    );
    expect(accepted.status).toBe(201);
    return accepted.body.pairing.id;
  }

  /** Call the authenticated, server-authoritative calendar mutation path. */
  async function mutate(
    token: string,
    body: Record<string, unknown>,
  ): Promise<FunctionResponse<CalendarMutationBody>> {
    return callFunction<CalendarMutationBody>(config, 'calendar', body, token);
  }

  async function edgeCreateDate(
    token: string,
    title: string,
    date: CalendarDate,
    recurring = false,
  ): Promise<FunctionResponse<CalendarMutationBody>> {
    return mutate(token, { action: 'createDate', title, date, recurring });
  }

  async function edgeEditDate(
    token: string,
    id: string,
    title: string,
    date: CalendarDate,
    recurring = false,
  ): Promise<FunctionResponse<CalendarMutationBody>> {
    return mutate(token, { action: 'editDate', dateId: id, title, date, recurring });
  }

  async function edgeSetReminder(
    token: string,
    id: string,
    leadTime: number,
  ): Promise<FunctionResponse<CalendarMutationBody>> {
    return mutate(token, { action: 'setReminder', dateId: id, leadTime });
  }

  async function dates(client: SupabaseClient, pairing: string): Promise<CalendarDateRow[]> {
    const result = await client
      .from('relationship_dates')
      .select('id, pairing_id, title, date, recurring')
      .eq('pairing_id', pairing);
    expect(result.error, result.error?.message).toBeNull();
    return (result.data ?? []) as unknown as CalendarDateRow[];
  }

  async function reminders(client: SupabaseClient, pairing: string): Promise<ReminderRow[]> {
    const result = await client
      .from('reminders')
      .select('id, date_id, pairing_id, lead_time_ms, next_trigger_at, status')
      .eq('pairing_id', pairing)
      .order('id');
    expect(result.error, result.error?.message).toBeNull();
    return (result.data ?? []) as unknown as ReminderRow[];
  }

  function moduleFor(client: SupabaseClient): CalendarModule {
    return createCalendarModule(createSupabaseCalendarPorts(client));
  }

  function domainDate(row: CalendarDateRow): RelationshipDate {
    const [year, month, day] = row.date.split('-').map(Number);
    return {
      id: dateId(row.id),
      pairingId: pairingId(row.pairing_id),
      title: row.title,
      date: { year, month, day },
      recurring: row.recurring,
    };
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

  it('creates, edits, and deletes a date through the caller-scoped write path', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const moduleB = moduleFor(b.client);

    const createdDate = await moduleA.createDate(
      'Anniversary',
      {
        year: 2026,
        month: 6,
        day: 15,
      },
      true,
    );
    expect(createdDate.ok).toBe(true);
    if (!createdDate.ok) return;
    const createdId = createdDate.value.id;

    const afterCreate = await dates(b.client, pairing);
    expect(afterCreate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdId,
          pairing_id: pairing,
          title: 'Anniversary',
          date: '2026-06-15',
          recurring: true,
        }),
      ]),
    );

    const edited = await moduleA.editDate(createdId, 'Our day', {
      year: 2027,
      month: 7,
      day: 16,
    });
    expect(edited.ok).toBe(true);

    const afterEdit = await dates(b.client, pairing);
    expect(afterEdit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdId,
          title: 'Our day',
          date: '2027-07-16',
          recurring: true,
        }),
      ]),
    );

    const deleted = await moduleA.deleteDate(createdId);
    expect(deleted.ok).toBe(true);
    // The partner module is intentionally a separate caller-scoped instance;
    // its list read proves the persisted state visible to the other partner.
    expect(
      (await moduleB.listDates({ year: 2026, month: 1, day: 1 })).some(
        (row) => row.id === createdId,
      ),
    ).toBe(false);
    expect((await dates(b.client, pairing)).some((row) => row.id === createdId)).toBe(false);
  }, 60_000);

  it('rejects a create from an account that is not paired', async () => {
    const a = await member();
    const before = await admin.from('relationship_dates').select('id');
    expect(before.error).toBeNull();

    const rejected = await edgeCreateDate(a.token, 'No partner', {
      year: 2026,
      month: 1,
      day: 1,
    });
    expect(rejected.body.error?.code).toBe('PAIRING_REQUIRED');

    const after = await admin.from('relationship_dates').select('id');
    expect(after.error).toBeNull();
    expect(after.data ?? []).toHaveLength(before.data?.length ?? 0);
  }, 60_000);

  it('rejects invalid title/date writes without mutating stored dates', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const valid = await moduleA.createDate('Stable', { year: 2026, month: 5, day: 5 }, false);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const id = valid.value.id as string;
    const before = await dates(b.client, pairing);

    const blankTitle = await edgeCreateDate(a.token, '   ', { year: 2026, month: 5, day: 6 });
    expect(blankTitle.body.error?.code).toBe('INVALID_TITLE');
    expect(await dates(b.client, pairing)).toEqual(before);

    const missingTitle = await mutate(a.token, {
      action: 'createDate',
      date: { year: 2026, month: 5, day: 6 },
      recurring: false,
    });
    expect(missingTitle.body.error?.code).toBe('INVALID_TITLE');
    expect(await dates(b.client, pairing)).toEqual(before);

    const longTitle = await edgeEditDate(a.token, id, 'x'.repeat(101), {
      year: 2026,
      month: 5,
      day: 6,
    });
    expect(longTitle.body.error?.code).toBe('INVALID_TITLE');
    expect(await dates(b.client, pairing)).toEqual(before);

    const invalidDate = await edgeEditDate(a.token, id, 'Still stable', {
      year: 2026,
      month: 2,
      day: 30,
    });
    expect(invalidDate.body.error?.code).toBe('INVALID_DATE');
    expect(await dates(b.client, pairing)).toEqual(before);

    const missingDate = await mutate(a.token, {
      action: 'editDate',
      dateId: id,
      title: 'Still stable',
    });
    expect(missingDate.body.error?.code).toBe('INVALID_DATE');
    expect(await dates(b.client, pairing)).toEqual(before);

    // The database constraints independently protect the RLS write surface if
    // a modified client bypasses the Edge Function's shared validators.
    const whitespaceBypass = await a.client.from('relationship_dates').insert({
      pairing_id: pairing,
      title: '\t\n',
      date: '2026-05-06',
      recurring: false,
    });
    expect(whitespaceBypass.error?.code).toBe('23514');
    const yearBypass = await a.client.from('relationship_dates').insert({
      pairing_id: pairing,
      title: 'Out of range',
      date: '10000-01-01',
      recurring: false,
    });
    expect(yearBypass.error?.code).toBe('23514');
    const utf16LengthBypass = await a.client.from('relationship_dates').insert({
      pairing_id: pairing,
      title: '😀'.repeat(51),
      date: '2026-05-06',
      recurring: false,
    });
    expect(utf16LengthBypass.error?.code).toBe('23514');
    expect(await dates(b.client, pairing)).toEqual(before);
  }, 60_000);

  it('rejects edit and delete of a date that is not in the pairing', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const missing = randomUUID();
    const before = await dates(b.client, pairing);
    const moduleA = moduleFor(a.client);

    const edited = await moduleA.editDate(dateId(missing), 'Missing', {
      year: 2026,
      month: 1,
      day: 1,
    });
    expect(edited.ok).toBe(false);
    if (edited.ok) return;
    expect(edited.error.code).toBe('DATE_NOT_FOUND');
    const deleted = await moduleA.deleteDate(dateId(missing));
    expect(deleted.ok).toBe(false);
    if (deleted.ok) return;
    expect(deleted.error.code).toBe('DATE_NOT_FOUND');
    expect(await dates(b.client, pairing)).toEqual(before);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Task 18.2 — reminder scheduling and delivery lifecycle
  // -------------------------------------------------------------------------

  it('persists an exact trigger and exposes the scheduled reminder to both partners', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const created = await moduleA.createDate(
      'Future reminder',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const leadTime = 2 * 60 * 60 * 1_000;
    const expectedTrigger = reminderTriggerTime({ year: 2099, month: 12, day: 31 }, leadTime);
    const response = await edgeSetReminder(a.token, String(created.value.id), leadTime);
    expect(response.status).toBe(201);
    expect(response.body.reminder).toMatchObject({
      id: expect.any(String),
      dateId: String(created.value.id),
      pairingId: pairing,
      leadTime,
      status: 'scheduled',
    });
    expect(Date.parse(response.body.reminder?.nextTriggerAt ?? '')).toBe(expectedTrigger);

    const visible = await reminders(b.client, pairing);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: response.body.reminder?.id,
          date_id: String(created.value.id),
          pairing_id: pairing,
          lead_time_ms: leadTime,
          status: 'scheduled',
        }),
      ]),
    );
    const persisted = visible.find((row) => row.id === response.body.reminder?.id);
    expect(Date.parse(persisted?.next_trigger_at ?? '')).toBe(expectedTrigger);
  }, 60_000);

  it('accepts the inclusive one-minute and 365-day lead-time boundaries when future', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const created = await moduleA.createDate(
      'Boundary reminder',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const leadTime of [MIN_LEAD_TIME, MAX_LEAD_TIME]) {
      const response = await edgeSetReminder(a.token, String(created.value.id), leadTime);
      expect(response.status).toBe(201);
      expect(response.body.reminder).toMatchObject({
        dateId: String(created.value.id),
        pairingId: pairing,
        leadTime,
        status: 'scheduled',
      });
    }

    const rows = await reminders(b.client, pairing);
    expect(rows.filter((row) => row.date_id === String(created.value.id))).toHaveLength(2);
    expect(
      rows
        .filter((row) => row.date_id === String(created.value.id))
        .map((row) => row.lead_time_ms)
        .sort((x, y) => x - y),
    ).toEqual([MIN_LEAD_TIME, MAX_LEAD_TIME]);
  }, 60_000);

  it('rejects out-of-range and non-future reminders without changing stored rows', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const future = await moduleA.createDate(
      'Rejected future controls',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    const past = await moduleA.createDate('Past date', { year: 2020, month: 1, day: 1 }, false);
    expect(future.ok).toBe(true);
    expect(past.ok).toBe(true);
    if (!future.ok || !past.ok) return;

    const before = await reminders(b.client, pairing);
    for (const leadTime of [MIN_LEAD_TIME - 1, MAX_LEAD_TIME + 1]) {
      const rejected = await edgeSetReminder(a.token, String(future.value.id), leadTime);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error?.code).toBe('INVALID_LEAD_TIME');
    }
    const nonFuture = await edgeSetReminder(a.token, String(past.value.id), MIN_LEAD_TIME);
    expect(nonFuture.status).toBe(400);
    expect(nonFuture.body.error?.code).toBe('INVALID_LEAD_TIME');
    expect(await reminders(b.client, pairing)).toEqual(before);
  }, 60_000);

  it('returns DATE_NOT_FOUND for a missing or foreign relationship date', async () => {
    const a = await member();
    const b = await member();
    const c = await member();
    const d = await member();
    const pairing = await pair(a.token, b.token);
    await pair(c.token, d.token);
    const foreignModule = moduleFor(c.client);
    const foreignDate = await foreignModule.createDate(
      'Foreign date',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(foreignDate.ok).toBe(true);
    if (!foreignDate.ok) return;

    const missing = await edgeSetReminder(a.token, randomUUID(), MIN_LEAD_TIME);
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe('DATE_NOT_FOUND');

    const foreign = await edgeSetReminder(a.token, String(foreignDate.value.id), MIN_LEAD_TIME);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error?.code).toBe('DATE_NOT_FOUND');
    expect(await reminders(b.client, pairing)).toEqual([]);
  }, 60_000);

  it('cascades reminders when their relationship date is deleted', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const created = await moduleA.createDate(
      'Cascading reminder',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const scheduled = await edgeSetReminder(a.token, String(created.value.id), MIN_LEAD_TIME);
    expect(scheduled.status).toBe(201);
    expect(
      (await reminders(b.client, pairing)).some((row) => row.date_id === created.value.id),
    ).toBe(true);

    const deleted = await moduleA.deleteDate(created.value.id);
    expect(deleted.ok).toBe(true);
    expect(
      (await reminders(b.client, pairing)).some((row) => row.date_id === created.value.id),
    ).toBe(false);
  }, 60_000);

  it('blocks authenticated direct reminder mutations even for a paired member', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const created = await moduleA.createDate(
      'Protected reminder',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const scheduled = await edgeSetReminder(a.token, String(created.value.id), MIN_LEAD_TIME);
    expect(scheduled.status).toBe(201);
    const reminderId = scheduled.body.reminder?.id;
    expect(reminderId).toEqual(expect.any(String));
    if (typeof reminderId !== 'string') return;
    const before = await reminders(b.client, pairing);

    const inserted = await a.client.from('reminders').insert({
      date_id: String(created.value.id),
      pairing_id: pairing,
      lead_time_ms: MIN_LEAD_TIME,
      next_trigger_at: new Date(Date.UTC(2099, 11, 30)).toISOString(),
      status: 'scheduled',
    });
    expect(inserted.error).not.toBeNull();
    expect(inserted.error?.code).toBe('42501');

    const updated = await a.client
      .from('reminders')
      .update({ lead_time_ms: MAX_LEAD_TIME })
      .eq('id', reminderId);
    expect(updated.error).not.toBeNull();
    expect(updated.error?.code).toBe('42501');

    const removed = await a.client.from('reminders').delete().eq('id', reminderId);
    expect(removed.error).not.toBeNull();
    expect(removed.error?.code).toBe('42501');
    expect(await reminders(b.client, pairing)).toEqual(before);
  }, 60_000);

  it('rearms a recurring reminder with the same lead and marks a one-off delivered', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const recurring = await moduleA.createDate(
      'Recurring delivery',
      { year: 2099, month: 12, day: 31 },
      true,
    );
    const oneOff = await moduleA.createDate(
      'One-off delivery',
      { year: 2099, month: 12, day: 31 },
      false,
    );
    expect(recurring.ok).toBe(true);
    expect(oneOff.ok).toBe(true);
    if (!recurring.ok || !oneOff.ok) return;

    const leadTime = 3 * 60 * 60 * 1_000;
    const recurringSet = await edgeSetReminder(a.token, String(recurring.value.id), leadTime);
    const oneOffSet = await edgeSetReminder(a.token, String(oneOff.value.id), leadTime);
    expect(recurringSet.status).toBe(201);
    expect(oneOffSet.status).toBe(201);
    const recurringId = recurringSet.body.reminder?.id as string;
    const oneOffId = oneOffSet.body.reminder?.id as string;
    expect(recurringId).toEqual(expect.any(String));
    expect(oneOffId).toEqual(expect.any(String));
    if (typeof recurringId !== 'string' || typeof oneOffId !== 'string') return;

    const deliveredAt = '2099-01-01T00:00:00.000Z';
    const recurringAdvance = await admin.rpc('advance_calendar_reminder_after_delivery', {
      p_reminder: recurringId,
      p_delivered_at: deliveredAt,
    });
    expect(recurringAdvance.error, recurringAdvance.error?.message).toBeNull();
    const recurringRow = (
      Array.isArray(recurringAdvance.data) ? recurringAdvance.data[0] : recurringAdvance.data
    ) as Record<string, unknown> | null;
    expect(recurringRow).toMatchObject({
      result_code: 'OK',
      reminder_id: recurringId,
      date_id: String(recurring.value.id),
      pairing_id: pairing,
      lead_time_ms: leadTime,
      status: 'scheduled',
    });
    // The original reminder was scheduled for the 2026 occurrence. Delivery
    // was deferred until 2099, so the transaction skips every already-due
    // annual trigger and rearms the first future one in December 2099.
    expect(Date.parse(String(recurringRow?.next_trigger_at))).toBe(Date.UTC(2099, 11, 30, 21));

    const oneOffAdvance = await admin.rpc('advance_calendar_reminder_after_delivery', {
      p_reminder: oneOffId,
      p_delivered_at: deliveredAt,
    });
    expect(oneOffAdvance.error, oneOffAdvance.error?.message).toBeNull();
    const oneOffRow = (
      Array.isArray(oneOffAdvance.data) ? oneOffAdvance.data[0] : oneOffAdvance.data
    ) as Record<string, unknown> | null;
    expect(oneOffRow).toMatchObject({
      result_code: 'OK',
      reminder_id: oneOffId,
      date_id: String(oneOff.value.id),
      pairing_id: pairing,
      lead_time_ms: leadTime,
      status: 'delivered',
    });

    const rows = await reminders(b.client, pairing);
    expect(rows.find((row) => row.id === recurringId)).toMatchObject({
      lead_time_ms: leadTime,
      status: 'scheduled',
    });
    expect(Date.parse(String(rows.find((row) => row.id === recurringId)?.next_trigger_at))).toBe(
      Date.UTC(2099, 11, 30, 21),
    );
    expect(rows.find((row) => row.id === oneOffId)?.status).toBe('delivered');
  }, 60_000);

  it('orders the caller-visible dates by next occurrence, then title', async () => {
    const a = await member();
    const b = await member();
    const pairing = await pair(a.token, b.token);
    const moduleA = moduleFor(a.client);
    const moduleB = moduleFor(b.client);

    await moduleA.createDate('zeta', { year: 2026, month: 7, day: 4 }, true);
    await moduleA.createDate('Alpha', { year: 2026, month: 7, day: 4 }, true);
    await moduleA.createDate('May', { year: 2026, month: 5, day: 1 }, true);

    const ordered = await moduleB.listDates({ year: 2026, month: 1, day: 1 });
    expect(ordered.map((date) => date.title)).toEqual(['May', 'Alpha', 'zeta']);
    expect((await dates(b.client, pairing)).map(domainDate)).toHaveLength(3);
  }, 60_000);

  it(
    "delivers a partner's create, edit, and delete within 5 seconds each",
    async () => {
      const a = await member();
      const b = await member();
      const pairing = await pair(a.token, b.token);

      const live = await withRealtimeRetry(async () => {
        const received: string[] = [];
        const candidate = moduleFor(b.client);
        const unsubscribe = candidate.subscribeCache(() => {
          received.push(
            ...candidate.cached({ year: 2026, month: 1, day: 1 }).map((date) => String(date.id)),
          );
        });
        candidate.subscribe(pairingId(pairing));

        // Warm up outside the measured budget. A fresh channel is required on a
        // failed attempt; waiting longer on the dead first channel does not fix
        // the post-reset Realtime replication-slot race.
        const moduleA = moduleFor(a.client);
        await moduleA.createDate(
          `warm-${randomUUID()}`,
          {
            year: 2026,
            month: 8,
            day: 8,
          },
          false,
        );
        const deadline = Date.now() + 6_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (received.length === 0) {
          unsubscribe();
          candidate.unsubscribe();
          return null;
        }
        return { candidate, unsubscribe };
      });

      const moduleA = moduleFor(a.client);

      async function waitForPartner(started: number, predicate: () => boolean): Promise<void> {
        while (!predicate() && Date.now() - started < PROPAGATION_BUDGET_MS) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(predicate()).toBe(true);
        expect(Date.now() - started).toBeLessThan(PROPAGATION_BUDGET_MS);
      }

      const createStarted = Date.now();
      const createdDate = await moduleA.createDate(
        'Realtime anniversary',
        {
          year: 2026,
          month: 9,
          day: 9,
        },
        false,
      );
      expect(createdDate.ok).toBe(true);
      if (!createdDate.ok) return;
      const id = String(createdDate.value.id);

      try {
        await waitForPartner(createStarted, () =>
          live.candidate
            .cached({ year: 2026, month: 1, day: 1 })
            .some((date) => String(date.id) === id && date.title === 'Realtime anniversary'),
        );

        const editStarted = Date.now();
        const editedDate = await moduleA.editDate(
          createdDate.value.id,
          'Realtime anniversary edited',
          {
            year: 2027,
            month: 10,
            day: 10,
          },
        );
        expect(editedDate.ok).toBe(true);
        if (!editedDate.ok) return;
        await waitForPartner(editStarted, () =>
          live.candidate
            .cached({ year: 2026, month: 1, day: 1 })
            .some(
              (date) =>
                String(date.id) === id &&
                date.title === 'Realtime anniversary edited' &&
                date.date.year === 2027 &&
                date.date.month === 10 &&
                date.date.day === 10,
            ),
        );

        const deleteStarted = Date.now();
        const deletedDate = await moduleA.deleteDate(createdDate.value.id);
        expect(deletedDate.ok).toBe(true);
        if (!deletedDate.ok) return;
        await waitForPartner(
          deleteStarted,
          () =>
            !live.candidate
              .cached({ year: 2026, month: 1, day: 1 })
              .some((date) => String(date.id) === id),
        );
      } finally {
        live.unsubscribe();
        live.candidate.unsubscribe();
      }
    },
    SUBSCRIBE_TIMEOUT_MS + 40_000,
  );
});
