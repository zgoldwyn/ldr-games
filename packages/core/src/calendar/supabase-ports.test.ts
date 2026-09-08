import { describe, expect, it } from 'vitest';

import { calendarDateFromRow, relationshipDateFromWire } from './supabase-ports.js';

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
