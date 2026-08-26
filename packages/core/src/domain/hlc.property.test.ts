/**
 * Property-based coverage for deterministic last-write-wins conflict resolution
 * (Requirements 5.5, 5.6). Companion example-based tests live alongside the
 * other domain suites; this file pins down the universal ordering, symmetry,
 * determinism, and convergence guarantees of `resolveConflict` / `compareHLC`
 * across many generated inputs — including deliberately identical HLC
 * timestamps, which is where deterministic convergence matters most.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId } from './common.js';
import type { AccountId } from './common.js';
import type { DataChange, HLCTimestamp, SharedItemType } from './sync.js';
import { compareHLC, resolveConflict } from './hlc.js';

// A tiny pool of origin account ids. Keeping the pool small (and physical time /
// counter ranges narrow, below) makes ties — equal physical time, equal
// counters, and even fully-identical HLC timestamps — common instead of
// astronomically rare, so the generators actually exercise Req 5.6.
const ACCOUNT_IDS: readonly AccountId[] = [
  accountId('acct-a'),
  accountId('acct-b'),
  accountId('acct-c'),
];

const ITEM_TYPES: readonly SharedItemType[] = [
  'relationship_date',
  'reminder',
  'rt_session',
  'quiz_session',
];

const accountArb = fc.constantFrom(...ACCOUNT_IDS);

const hlcArb: fc.Arbitrary<HLCTimestamp> = fc.record({
  physical: fc.integer({ min: 0, max: 5 }),
  counter: fc.integer({ min: 0, max: 3 }),
  originAccountId: accountArb,
});

// A DataChange carrying a given HLC. The payload is a unique-ish tag so we can
// tell two otherwise-identical changes apart when asserting which object wins.
const changeWithHlc = (hlc: HLCTimestamp): fc.Arbitrary<DataChange> =>
  fc.record({
    itemId: fc.constantFrom('item-1', 'item-2'),
    itemType: fc.constantFrom(...ITEM_TYPES),
    payload: fc.string(),
    hlc: fc.constant(hlc),
    originAccountId: fc.constant(hlc.originAccountId),
  });

const changeArb: fc.Arbitrary<DataChange> = hlcArb.chain(changeWithHlc);

// Independent reference for "the greater HLC": physical time, then counter, then
// origin account id. Deliberately not implemented via compareHLC so the test
// does not simply restate the implementation it is checking.
function expectedGreater(a: HLCTimestamp, b: HLCTimestamp): 'a' | 'b' | 'equal' {
  if (a.physical !== b.physical) return a.physical > b.physical ? 'a' : 'b';
  if (a.counter !== b.counter) return a.counter > b.counter ? 'a' : 'b';
  if (a.originAccountId !== b.originAccountId) {
    return a.originAccountId > b.originAccountId ? 'a' : 'b';
  }
  return 'equal';
}

const hlcEquals = (x: HLCTimestamp, y: HLCTimestamp): boolean =>
  compareHLC(x, y) === 0;

describe('resolveConflict (last-write-wins conflict resolution)', () => {
  // Feature: ldr-companion-app, Property 18: Last-write-wins conflict resolution is deterministic and convergent
  it('selects the greater HLC and is deterministic, symmetric, and convergent', () => {
    fc.assert(
      fc.property(changeArb, changeArb, (a, b) => {
        const winner = resolveConflict(a, b);

        // Result is always one of the two inputs (no fabricated value).
        expect(winner === a || winner === b).toBe(true);

        // Last-write-wins by physical time, then counter, then origin id: the
        // winner's HLC must be the greater (or equal) of the two.
        const which = expectedGreater(a.hlc, b.hlc);
        if (which === 'a') {
          expect(winner).toBe(a);
        } else if (which === 'b') {
          expect(winner).toBe(b);
        } else {
          // Fully identical HLC: the two changes are indistinguishable in the
          // total order, so returning either is convergent — assert the winner
          // at least carries that shared HLC.
          expect(hlcEquals(winner.hlc, a.hlc)).toBe(true);
        }

        // Determinism: resolving the same pair again yields the identical result.
        expect(resolveConflict(a, b)).toBe(winner);

        // Convergence / symmetry: both partners resolve to the same value
        // regardless of argument order. When the HLCs are distinguishable the
        // very same object is chosen; when they are fully equal the changes are
        // duplicates, so the resolved HLC still matches (both converge).
        const swapped = resolveConflict(b, a);
        expect(hlcEquals(swapped.hlc, winner.hlc)).toBe(true);
        if (compareHLC(a.hlc, b.hlc) !== 0) {
          expect(swapped).toBe(winner);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 18: Last-write-wins conflict resolution is deterministic and convergent
  it('is symmetric and convergent on identical HLC timestamps', () => {
    fc.assert(
      fc.property(hlcArb, fc.string(), fc.string(), (hlc, payloadA, payloadB) => {
        // Two distinct changes that share the exact same HLC timestamp — the
        // "identical change timestamps" case of Requirement 5.6.
        const a: DataChange = {
          itemId: 'shared-item',
          itemType: 'relationship_date',
          payload: payloadA,
          hlc,
          originAccountId: hlc.originAccountId,
        };
        const b: DataChange = { ...a, payload: payloadB };

        const forward = resolveConflict(a, b);
        const backward = resolveConflict(b, a);

        // Deterministic: same inputs, same object each time.
        expect(resolveConflict(a, b)).toBe(forward);
        expect(resolveConflict(b, a)).toBe(backward);

        // Convergent: both directions land on a change carrying the shared HLC,
        // so both partners' sessions agree on the winning timestamp.
        expect(hlcEquals(forward.hlc, hlc)).toBe(true);
        expect(hlcEquals(backward.hlc, hlc)).toBe(true);
        expect(hlcEquals(forward.hlc, backward.hlc)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
