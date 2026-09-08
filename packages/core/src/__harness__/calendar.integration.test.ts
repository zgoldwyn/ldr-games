import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createCalendarModule, type CalendarModule } from '../calendar/calendar-module.js';
import { createSupabaseCalendarPorts } from '../calendar/supabase-ports.js';
import { dateId, pairingId, type CalendarDate, type RelationshipDate } from '../domain/index.js';
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
  readonly error?: FunctionErrorBody['error'];
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

  async function dates(client: SupabaseClient, pairing: string): Promise<CalendarDateRow[]> {
    const result = await client
      .from('relationship_dates')
      .select('id, pairing_id, title, date, recurring')
      .eq('pairing_id', pairing);
    expect(result.error, result.error?.message).toBeNull();
    return (result.data ?? []) as unknown as CalendarDateRow[];
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
    "delivers a partner's committed date within 5 seconds",
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
        return { candidate, received, unsubscribe };
      });

      live.received.length = 0;
      const started = Date.now();
      const moduleA = moduleFor(a.client);
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
      while (live.received.length === 0 && Date.now() - started < PROPAGATION_BUDGET_MS) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(live.received.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(PROPAGATION_BUDGET_MS);
      expect(live.received).toContain(id);
      live.unsubscribe();
      live.candidate.unsubscribe();
    },
    SUBSCRIBE_TIMEOUT_MS + 40_000,
  );
});
