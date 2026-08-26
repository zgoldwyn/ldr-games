// Feature: ldr-companion-app, Property 33: Relationship date persistence round-trip
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { dateId, pairingId } from './common.js';
import type { CalendarDate, DateId, PairingId } from './common.js';
import type { RelationshipDate } from './calendar.js';
import {
  createDate,
  deleteDate,
  editDate,
  emptyCalendarState,
  findDate,
  hasDate,
  type CalendarState,
  type RelationshipDateUpdates,
} from './calendar-store.js';

/**
 * Property 33 (task 8.6) — Relationship date persistence round-trip.
 *
 * For any valid sequence of create / edit / delete operations over a single
 * pairing's set of relationship dates, the stored set reflects each operation:
 * a created date is present with exactly the created values (9.1), an edited
 * date shows the new field values while keeping its identity (9.2), and a
 * deleted date is absent afterwards (9.3). Every operation is also required to
 * leave the pairing's *other* dates untouched, so the round-trip is exact and
 * side-effect free.
 *
 * The generator drives a realistic transition sequence: it starts from a set of
 * uniquely-identified dates and applies a random op list, choosing edit/delete
 * targets from whatever dates currently exist and minting fresh ids for
 * creates. Invariants are checked after every single step, not just at the end.
 */
describe('calendar-store: relationship date persistence round-trip (property)', () => {
  const PAIRING: PairingId = pairingId('p1');

  const calendarDateArb: fc.Arbitrary<CalendarDate> = fc.record({
    year: fc.integer({ min: 1900, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  });

  // Titles vary freely (including whitespace/edge shapes) — persistence does not
  // validate them, and the round-trip must preserve whatever it is handed.
  const titleArb: fc.Arbitrary<string> = fc.string({ maxLength: 120 });

  // A create carries the full field set for a brand-new date; its id is assigned
  // at apply time so it is guaranteed unique within the pairing.
  interface CreateOp {
    readonly kind: 'create';
    readonly title: string;
    readonly date: CalendarDate;
    readonly recurring: boolean;
  }
  // Edit/delete pick an existing target via a [0,1) selector resolved against
  // the live set at apply time. `updates` may change any subset of mutable fields.
  interface EditOp {
    readonly kind: 'edit';
    readonly selector: number;
    readonly updates: RelationshipDateUpdates;
  }
  interface DeleteOp {
    readonly kind: 'delete';
    readonly selector: number;
  }
  type Op = CreateOp | EditOp | DeleteOp;

  const createOpArb: fc.Arbitrary<CreateOp> = fc.record({
    kind: fc.constant('create' as const),
    title: titleArb,
    date: calendarDateArb,
    recurring: fc.boolean(),
  });

  const updatesArb: fc.Arbitrary<RelationshipDateUpdates> = fc
    .record(
      {
        title: titleArb,
        date: calendarDateArb,
        recurring: fc.boolean(),
      },
      { requiredKeys: [] },
    )
    // Ensure at least one field is actually being updated so an edit is meaningful.
    .filter((u) => Object.keys(u).length > 0);

  const editOpArb: fc.Arbitrary<EditOp> = fc.record({
    kind: fc.constant('edit' as const),
    selector: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
    updates: updatesArb,
  });

  const deleteOpArb: fc.Arbitrary<DeleteOp> = fc.record({
    kind: fc.constant('delete' as const),
    selector: fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
  });

  const opArb: fc.Arbitrary<Op> = fc.oneof(createOpArb, editOpArb, deleteOpArb);

  // A starting set of dates with distinct ids (d0, d1, ...), plus the op sequence.
  const scenarioArb = fc.record({
    initial: fc.array(
      fc.record({ title: titleArb, date: calendarDateArb, recurring: fc.boolean() }),
      { maxLength: 8 },
    ),
    ops: fc.array(opArb, { maxLength: 30 }),
  });

  const pickTarget = (state: CalendarState, selector: number): DateId | undefined => {
    if (state.dates.length === 0) {
      return undefined;
    }
    const index = Math.min(state.dates.length - 1, Math.floor(selector * state.dates.length));
    return state.dates[index].id;
  };

  // Feature: ldr-companion-app, Property 33: Relationship date persistence round-trip
  // Validates: Requirements 9.1, 9.2, 9.3
  it('reflects create, edit, and delete operations exactly in the stored date set', () => {
    fc.assert(
      fc.property(scenarioArb, ({ initial, ops }) => {
        let state: CalendarState = {
          ...emptyCalendarState(),
          dates: initial.map((d, i) => ({
            id: dateId(`d${i}`),
            pairingId: PAIRING,
            title: d.title,
            date: d.date,
            recurring: d.recurring,
          })),
        };
        let nextId = initial.length;

        for (const op of ops) {
          const before = state;
          const otherIds = (id: DateId) => before.dates.filter((d) => d.id !== id);

          if (op.kind === 'create') {
            const created: RelationshipDate = {
              id: dateId(`d${nextId++}`),
              pairingId: PAIRING,
              title: op.title,
              date: op.date,
              recurring: op.recurring,
            };
            state = createDate(before, created);

            // 9.1: the created date is present with exactly the created values.
            expect(hasDate(state, created.id)).toBe(true);
            expect(findDate(state, created.id)).toEqual(created);
            expect(state.dates.length).toBe(before.dates.length + 1);
            // Reminders and pre-existing dates are untouched.
            expect(state.reminders).toBe(before.reminders);
            expect(otherIds(created.id)).toEqual(before.dates);
            continue;
          }

          const targetId = pickTarget(before, op.selector);
          if (targetId === undefined) {
            // Nothing to edit/delete yet; the success round-trip needs an
            // existing target, so skip (not-found rejection is Property 34).
            continue;
          }

          if (op.kind === 'edit') {
            const existing = findDate(before, targetId)!;
            const result = editDate(before, targetId, op.updates);
            expect(isOk(result)).toBe(true);
            if (!isOk(result)) continue;
            state = result.value;

            // 9.2: the edited date shows the new field values, with its identity
            // (id, pairingId) preserved.
            const updated = findDate(state, targetId);
            expect(updated).toEqual({
              ...existing,
              ...op.updates,
              id: existing.id,
              pairingId: existing.pairingId,
            });
            expect(state.dates.length).toBe(before.dates.length);
            // Every other date and all reminders are unchanged.
            expect(state.dates.filter((d) => d.id !== targetId)).toEqual(otherIds(targetId));
            expect(state.reminders).toBe(before.reminders);
          } else {
            const result = deleteDate(before, targetId);
            expect(isOk(result)).toBe(true);
            if (!isOk(result)) continue;
            state = result.value;

            // 9.3: the deleted date is absent afterwards.
            expect(hasDate(state, targetId)).toBe(false);
            expect(findDate(state, targetId)).toBeUndefined();
            expect(state.dates.length).toBe(before.dates.length - 1);
            // Every other date is preserved in order.
            expect(state.dates).toEqual(otherIds(targetId));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
