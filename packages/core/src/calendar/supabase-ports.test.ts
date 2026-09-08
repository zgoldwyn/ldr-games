import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dateId } from '../domain/common.js';

import {
  calendarDateFromRow,
  createSupabaseCalendarPorts,
  relationshipDateFromWire,
  reminderFromWire,
} from './supabase-ports.js';

describe('calendar Supabase row mapping', () => {
  it('maps a Postgres DATE text without timezone conversion', () => {
    expect(calendarDateFromRow('2032-02-29')).toEqual({ year: 2032, month: 2, day: 29 });
  });

  it('rejects invalid date text instead of normalizing it', () => {
    expect(calendarDateFromRow('2031-02-29')).toBeNull();
    expect(calendarDateFromRow('2030-1-02')).toBeNull();
  });

  it('maps both table rows and Edge Function responses', () => {
    expect(
      relationshipDateFromWire({
        id: 'd-1',
        pairing_id: 'p-1',
        title: 'Anniversary',
        date: '2030-06-10',
        recurring: true,
      }),
    ).toMatchObject({
      id: 'd-1',
      pairingId: 'p-1',
      date: { year: 2030, month: 6, day: 10 },
      recurring: true,
    });
    expect(
      relationshipDateFromWire({
        id: 'd-2',
        pairingId: 'p-1',
        title: 'Birthday',
        date: { year: 2030, month: 7, day: 3 },
        recurring: false,
      }),
    ).toMatchObject({ id: 'd-2', pairingId: 'p-1' });
  });
});

describe('calendar reminder Supabase mapping', () => {
  it('maps a table row with exact millisecond duration', () => {
    expect(
      reminderFromWire({
        id: 'r-1',
        date_id: 'd-1',
        pairing_id: 'p-1',
        lead_time_ms: 90_000,
        next_trigger_at: '2030-06-09T23:58:30.000Z',
        status: 'scheduled',
      }),
    ).toEqual({
      id: 'r-1',
      dateId: 'd-1',
      pairingId: 'p-1',
      leadTime: 90_000,
      nextTriggerAt: Date.UTC(2030, 5, 9, 23, 58, 30),
      status: 'scheduled',
    });
  });

  it('maps the stable Edge payload using the same millisecond contract', () => {
    expect(
      reminderFromWire({
        id: 'r-2',
        dateId: 'd-2',
        pairingId: 'p-1',
        leadTime: 86_400_000,
        nextTriggerAt: '2030-07-02T00:00:00.000Z',
        status: 'scheduled',
      }),
    ).toMatchObject({
      id: 'r-2',
      dateId: 'd-2',
      pairingId: 'p-1',
      leadTime: 86_400_000,
      nextTriggerAt: Date.UTC(2030, 6, 2),
      status: 'scheduled',
    });
  });

  it('rejects malformed reminder payloads rather than manufacturing a schedule', () => {
    expect(
      reminderFromWire({
        id: 'r-3',
        date_id: 'd-3',
        pairing_id: 'p-1',
        lead_time_ms: 60_000,
        next_trigger_at: 'not-a-timestamp',
        status: 'scheduled',
      }),
    ).toBeNull();
  });

  it('sends millisecond lead time to setReminder and maps its stable payload', async () => {
    const calls: { name: string; body: unknown }[] = [];
    const client = {
      functions: {
        invoke: async (name: string, options: { body: unknown }) => {
          calls.push({ name, body: options.body });
          return {
            data: {
              reminder: {
                id: 'r-4',
                dateId: 'd-4',
                pairingId: 'p-1',
                leadTime: 120_000,
                nextTriggerAt: '2030-06-10T00:00:00.000Z',
                status: 'scheduled',
              },
            },
            error: null,
          };
        },
      },
    } as unknown as SupabaseClient;

    const result = await createSupabaseCalendarPorts(client).setReminder(dateId('d-4'), 120_000);

    expect(calls).toEqual([
      { name: 'calendar', body: { action: 'setReminder', dateId: 'd-4', leadTime: 120_000 } },
    ]);
    expect(result).toMatchObject({
      ok: true,
      reminder: {
        leadTime: 120_000,
        nextTriggerAt: Date.UTC(2030, 5, 10),
      },
    });
  });
});
