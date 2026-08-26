import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { accountId } from '../domain/common.js';
import type { DataChange, HLCTimestamp, SharedItemType } from '../domain/sync.js';
import {
  acknowledge,
  drain,
  emptySyncQueue,
  enqueue,
  enqueueAll,
  pendingChanges,
  pendingEntries,
  queueSize,
  type SyncQueue,
} from './queue.js';

// Feature: ldr-companion-app, Property 17: Offline changes are queued without loss
//
// For any sequence of changes made while a client is offline, every change is
// retained in the synchronization queue in submission order until connectivity
// is restored (drained). Nothing is lost, nothing is reordered.
// Validates: Requirements 5.4

const ITEM_TYPES: readonly SharedItemType[] = [
  'relationship_date',
  'reminder',
  'rt_session',
  'async_session',
  'quiz_session',
  'quiz_self_answer',
  'quiz_guess',
  'notification_settings',
];

const hlcArb: fc.Arbitrary<HLCTimestamp> = fc.record({
  physical: fc.integer({ min: 0, max: 1_000_000 }),
  counter: fc.integer({ min: 0, max: 1000 }),
  originAccountId: fc.string({ minLength: 1, maxLength: 8 }).map(accountId),
});

// A DataChange generator. `payload` carries a unique tag so that even changes
// that look otherwise identical remain individually distinguishable — this lets
// the test detect silent loss or reordering that mere structural equality on
// coarse fields might miss.
const changeArb: fc.Arbitrary<DataChange> = fc
  .record({
    itemId: fc.string({ minLength: 1, maxLength: 12 }),
    itemType: fc.constantFrom(...ITEM_TYPES),
    tag: fc.integer(),
    hlc: hlcArb,
    originAccountId: fc.string({ minLength: 1, maxLength: 8 }).map(accountId),
  })
  .map(({ itemId, itemType, tag, hlc, originAccountId }) => ({
    itemId,
    itemType,
    payload: { tag },
    hlc,
    originAccountId,
  }));

// A non-empty run of offline changes; sequences are the interesting input space.
const changesArb = fc.array(changeArb, { minLength: 1, maxLength: 40 });

describe('Property 17: offline changes are queued without loss', () => {
  it('retains every offline change in submission order until drained', () => {
    fc.assert(
      fc.property(changesArb, (changes) => {
        // Enqueue the whole offline burst.
        const queued = enqueueAll(emptySyncQueue(), changes);

        // No loss: count is preserved.
        expect(queueSize(queued)).toBe(changes.length);

        // Order preserved while retained (inspection does not remove anything).
        expect(pendingChanges(queued)).toEqual(changes);

        // seq is monotonically increasing in submission order.
        expect(pendingEntries(queued).map((e) => e.seq)).toEqual(
          changes.map((_, i) => i),
        );

        // Draining (connectivity restored) yields exactly the submitted
        // changes, in submission order, and empties the queue.
        const { changes: drained, remaining } = drain(queued);
        expect(drained).toEqual(changes);
        expect(queueSize(remaining)).toBe(0);
      }),
    );
  });

  it('preserves order and loses nothing across interleaved enqueue/inspect steps', () => {
    // Enqueue one change at a time, mirroring how offline mutations trickle in,
    // and assert the retained sequence always equals every change submitted so
    // far in the exact order submitted.
    fc.assert(
      fc.property(changesArb, (changes) => {
        let queue: SyncQueue = emptySyncQueue();
        const submitted: DataChange[] = [];

        for (const change of changes) {
          queue = enqueue(queue, change);
          submitted.push(change);

          // Invariant after each step: no loss, order preserved.
          expect(pendingChanges(queue)).toEqual(submitted);
          expect(queueSize(queue)).toBe(submitted.length);
        }

        // Final drain surfaces every change exactly once, in order.
        expect(drain(queue).changes).toEqual(changes);
      }),
    );
  });

  it('retains changes through partial acknowledgement without loss or reorder', () => {
    // Model a two-phase drain: snapshot a prefix, write it, acknowledge exactly
    // those seqs, and enqueue more offline changes concurrently. The union of
    // acknowledged + still-pending changes must equal everything submitted, and
    // whatever remains must stay in submission order.
    fc.assert(
      fc.property(
        changesArb,
        fc.array(changeArb, { maxLength: 20 }),
        fc.nat(),
        (firstBatch, secondBatch, prefixSeed) => {
          const queued = enqueueAll(emptySyncQueue(), firstBatch);

          // Choose a prefix of the first batch to "write" and acknowledge.
          const prefixLen = prefixSeed % (firstBatch.length + 1);
          const ackEntries = pendingEntries(queued).slice(0, prefixLen);
          const ackedSeqs = ackEntries.map((e) => e.seq);
          const ackedChanges = ackEntries.map((e) => e.change);

          // Meanwhile, more offline changes arrive before we acknowledge.
          const withMore = enqueueAll(queued, secondBatch);
          const remaining = acknowledge(withMore, ackedSeqs);

          const remainingChanges = pendingChanges(remaining);

          // No loss: acknowledged + remaining == everything ever submitted.
          expect([...ackedChanges, ...remainingChanges]).toEqual([
            ...firstBatch,
            ...secondBatch,
          ]);

          // Order preserved: remaining is the submission-ordered leftover.
          const expectedRemaining = [...firstBatch, ...secondBatch].filter(
            (c) => !ackedChanges.includes(c),
          );
          expect(remainingChanges).toEqual(expectedRemaining);
        },
      ),
    );
  });
});
