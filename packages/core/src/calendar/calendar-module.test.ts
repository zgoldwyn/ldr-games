import { describe, expect, it } from 'vitest';

import { dateId, pairingId, type CalendarDate, type DateId } from '../domain/common.js';
import type { RelationshipDate } from '../domain/calendar.js';
import { ERROR_CODES, type CalendarError } from '../errors.js';
import {
  createCalendarModule,
  type CalendarPorts,
  type DateRemoteChange,
} from './calendar-module.js';

const PAIRING = pairingId('11111111-1111-4111-8111-111111111111');
const JAN_1: CalendarDate = { year: 2030, month: 1, day: 1 };

function relationshipDate(overrides: Partial<RelationshipDate> = {}): RelationshipDate {
  return {
    id: dateId('d-1'),
    pairingId: PAIRING,
    title: 'Anniversary',
    date: { year: 2030, month: 6, day: 10 },
    recurring: false,
    ...overrides,
  };
}

function calendarError(code: CalendarError['code']): CalendarError {
  return { code, message: code };
}

function harness(initial: readonly RelationshipDate[] = []) {
  let rows = [...initial];
  let fetch: () => Promise<readonly RelationshipDate[] | null> = async () => rows;
  let remote: ((change: DateRemoteChange) => void) | null = null;
  let unsubscribeCount = 0;
  const creates: { title: string; date: CalendarDate; recurring: boolean }[] = [];
  const edits: { id: DateId; title: string; date: CalendarDate; recurring?: boolean }[] = [];
  const deletes: DateId[] = [];
  let createOutcome: ReturnType<CalendarPorts['createDate']> extends Promise<infer T> ? T : never =
    {
      ok: true,
      date: relationshipDate(),
    };
  let editOutcome: ReturnType<CalendarPorts['editDate']> extends Promise<infer T> ? T : never = {
    ok: true,
    date: relationshipDate(),
  };
  let deleteOutcome: ReturnType<CalendarPorts['deleteDate']> extends Promise<infer T> ? T : never =
    {
      ok: true,
    };

  const ports: CalendarPorts = {
    fetchDates: () => fetch(),
    createDate: async (title, date, recurring) => {
      creates.push({ title, date, recurring });
      return createOutcome;
    },
    editDate: async (id, title, date, recurring) => {
      edits.push({ id, title, date, ...(recurring === undefined ? {} : { recurring }) });
      return editOutcome;
    },
    deleteDate: async (id) => {
      deletes.push(id);
      return deleteOutcome;
    },
    subscribeDates: (_pairingId, handler) => {
      remote = handler;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  return {
    module: createCalendarModule(ports),
    creates,
    edits,
    deletes,
    setRows: (next: readonly RelationshipDate[]) => {
      rows = [...next];
    },
    setFetch: (next: () => Promise<readonly RelationshipDate[] | null>) => {
      fetch = next;
    },
    setCreateOutcome: (next: typeof createOutcome) => {
      createOutcome = next;
    },
    setEditOutcome: (next: typeof editOutcome) => {
      editOutcome = next;
    },
    setDeleteOutcome: (next: typeof deleteOutcome) => {
      deleteOutcome = next;
    },
    emit: (change: DateRemoteChange) => remote?.(change),
    unsubscribes: () => unsubscribeCount,
  };
}

describe('Calendar module — mutation validation and cache (Req 9.1–9.6)', () => {
  it('writes a valid create through its port and immediately caches the server date', async () => {
    const created = relationshipDate({ id: dateId('created'), title: 'Our day', recurring: true });
    const h = harness();
    h.setCreateOutcome({ ok: true, date: created });

    const result = await h.module.createDate('Our day', created.date, true);

    expect(result).toEqual({ ok: true, value: created });
    expect(h.creates).toEqual([{ title: 'Our day', date: created.date, recurring: true }]);
    expect(h.module.cached(JAN_1)).toEqual([created]);
  });

  it('rejects an invalid title locally without issuing a write or disturbing cache', async () => {
    const existing = relationshipDate();
    const h = harness([existing]);
    await h.module.listDates(JAN_1);

    const result = await h.module.createDate('   ', existing.date, false);

    expect(result).toMatchObject({ ok: false, error: { code: ERROR_CODES.INVALID_TITLE } });
    expect(h.creates).toEqual([]);
    expect(h.module.cached(JAN_1)).toEqual([existing]);
  });

  it('rejects an invalid edit date locally without issuing a write', async () => {
    const h = harness();
    const result = await h.module.editDate(dateId('d-1'), 'Still good', {
      year: 2029,
      month: 2,
      day: 29,
    });

    expect(result).toMatchObject({ ok: false, error: { code: ERROR_CODES.INVALID_DATE } });
    expect(h.edits).toEqual([]);
  });

  it('preserves its cached state when a server mutation is rejected', async () => {
    const existing = relationshipDate();
    const h = harness([existing]);
    await h.module.listDates(JAN_1);
    h.setEditOutcome({ ok: false, error: calendarError(ERROR_CODES.DATE_NOT_FOUND) });

    const result = await h.module.editDate(existing.id, 'Changed', existing.date);

    expect(result).toEqual({ ok: false, error: calendarError(ERROR_CODES.DATE_NOT_FOUND) });
    expect(h.module.cached(JAN_1)).toEqual([existing]);
  });

  it('forwards an explicit recurrence edit while retaining the design API default', async () => {
    const existing = relationshipDate({ recurring: false });
    const changed = relationshipDate({ recurring: true });
    const h = harness();
    h.setEditOutcome({ ok: true, date: changed });

    await h.module.editDate(existing.id, existing.title, existing.date, true);

    expect(h.edits).toEqual([
      { id: existing.id, title: existing.title, date: existing.date, recurring: true },
    ]);
    expect(h.module.cached(JAN_1)).toEqual([changed]);
  });

  it('removes a successfully deleted date from cache, but not a rejected deletion', async () => {
    const existing = relationshipDate();
    const h = harness([existing]);
    await h.module.listDates(JAN_1);
    h.setDeleteOutcome({ ok: false, error: calendarError(ERROR_CODES.DATE_NOT_FOUND) });

    await h.module.deleteDate(existing.id);
    expect(h.module.cached(JAN_1)).toEqual([existing]);

    h.setDeleteOutcome({ ok: true });
    expect(await h.module.deleteDate(existing.id)).toEqual({ ok: true, value: undefined });
    expect(h.deletes).toEqual([existing.id, existing.id]);
    expect(h.module.cached(JAN_1)).toEqual([]);
  });
});

describe('Calendar module — ordering and Postgres Changes (Req 9.1–9.3, 9.7)', () => {
  it('orders the RLS-backed list with orderDates rather than database insertion order', async () => {
    const march = relationshipDate({
      id: dateId('march'),
      title: 'Zebra',
      date: { year: 2030, month: 3, day: 1 },
    });
    const janB = relationshipDate({
      id: dateId('jan-b'),
      title: 'beta',
      date: { year: 2030, month: 1, day: 2 },
    });
    const janA = relationshipDate({
      id: dateId('jan-a'),
      title: 'Alpha',
      date: { year: 2030, month: 1, day: 2 },
    });
    const h = harness([march, janB, janA]);

    expect((await h.module.listDates(JAN_1)).map((date) => date.id)).toEqual([
      janA.id,
      janB.id,
      march.id,
    ]);
  });

  it('applies partner INSERT, UPDATE and DELETE events and tears down the old stream', async () => {
    const original = relationshipDate({ id: dateId('shared'), title: 'Original' });
    const changed = relationshipDate({ id: original.id, title: 'Changed' });
    const h = harness();

    // Shells commonly destructure action methods before handing them to an
    // effect. The subscription callback must not rely on the module's `this`.
    const { subscribe } = h.module;
    subscribe(PAIRING);
    h.emit({ event: 'INSERT', id: original.id, date: original });
    h.emit({ event: 'UPDATE', id: changed.id, date: changed });
    expect(h.module.cached(JAN_1)).toEqual([changed]);

    // Exactly one active pairing subscription prevents duplicate change delivery.
    h.module.subscribe(PAIRING);
    expect(h.unsubscribes()).toBe(1);
    h.emit({ event: 'DELETE', id: changed.id });
    expect(h.module.cached(JAN_1)).toEqual([]);

    h.module.unsubscribe();
    expect(h.unsubscribes()).toBe(2);
  });

  it('keeps last-known data when the list read fails', async () => {
    const existing = relationshipDate();
    const h = harness([existing]);
    await h.module.listDates(JAN_1);
    h.setFetch(async () => null);

    expect(await h.module.listDates(JAN_1)).toEqual([existing]);
  });

  it('does not resurrect a date when a late list response loses to a DELETE event', async () => {
    const existing = relationshipDate({ id: dateId('late') });
    let resolveFetch: ((value: readonly RelationshipDate[]) => void) | null = null;
    const h = harness();
    h.setFetch(
      () =>
        new Promise<readonly RelationshipDate[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    h.module.subscribe(PAIRING);

    const list = h.module.listDates(JAN_1);
    h.emit({ event: 'DELETE', id: existing.id });
    resolveFetch?.([existing]);

    expect(await list).toEqual([]);
    expect(h.module.cached(JAN_1)).toEqual([]);
  });

  it('does not let an older overlapping list overwrite a later list response', async () => {
    const oldDate = relationshipDate({ id: dateId('old'), title: 'Old' });
    const newDate = relationshipDate({ id: dateId('new'), title: 'New' });
    let resolveOld: ((value: readonly RelationshipDate[]) => void) | null = null;
    let resolveNew: ((value: readonly RelationshipDate[]) => void) | null = null;
    let calls = 0;
    const h = harness();
    h.setFetch(
      () =>
        new Promise<readonly RelationshipDate[]>((resolve) => {
          calls += 1;
          if (calls === 1) resolveOld = resolve;
          else resolveNew = resolve;
        }),
    );

    const older = h.module.listDates(JAN_1);
    const newer = h.module.listDates(JAN_1);
    resolveNew?.([newDate]);
    expect(await newer).toEqual([newDate]);

    resolveOld?.([oldDate]);
    expect(await older).toEqual([newDate]);
    expect(h.module.cached(JAN_1)).toEqual([newDate]);
  });
});
