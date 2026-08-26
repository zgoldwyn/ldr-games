import { describe, expect, it } from 'vitest';
import { accountId } from '../domain/common.js';
import type { DataChange, HLCTimestamp } from '../domain/sync.js';
import {
  acknowledge,
  drain,
  emptySyncQueue,
  enqueue,
  enqueueAll,
  isQueueEmpty,
  pendingChanges,
  pendingEntries,
  queueSize,
} from './queue.js';

const origin = accountId('acct-1');

function hlc(physical: number, counter = 0): HLCTimestamp {
  return { physical, counter, originAccountId: origin };
}

function change(itemId: string, physical: number): DataChange {
  return {
    itemId,
    itemType: 'relationship_date',
    payload: { itemId, physical },
    hlc: hlc(physical),
    originAccountId: origin,
  };
}

describe('SyncQueue', () => {
  it('starts empty', () => {
    const q = emptySyncQueue();
    expect(isQueueEmpty(q)).toBe(true);
    expect(queueSize(q)).toBe(0);
    expect(pendingChanges(q)).toEqual([]);
  });

  it('enqueue appends in submission order and assigns monotonic seqs', () => {
    const a = change('a', 1);
    const b = change('b', 2);
    const c = change('c', 3);

    const q = enqueueAll(emptySyncQueue(), [a, b, c]);

    expect(queueSize(q)).toBe(3);
    expect(pendingChanges(q)).toEqual([a, b, c]);
    expect(pendingEntries(q).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('enqueue does not mutate the input queue (immutability)', () => {
    const q0 = emptySyncQueue();
    const q1 = enqueue(q0, change('a', 1));

    expect(isQueueEmpty(q0)).toBe(true);
    expect(queueSize(q1)).toBe(1);
    expect(q1).not.toBe(q0);
  });

  it('retains all changes until explicitly drained', () => {
    const changes = [change('a', 1), change('b', 2)];
    const q = enqueueAll(emptySyncQueue(), changes);

    // Inspecting does not remove anything.
    expect(pendingChanges(q)).toEqual(changes);
    expect(queueSize(q)).toBe(2);
  });

  it('drain returns all changes in submission order and empties the queue', () => {
    const changes = [change('a', 3), change('b', 1), change('c', 2)];
    const q = enqueueAll(emptySyncQueue(), changes);

    const { changes: drained, remaining } = drain(q);

    // Submission order is preserved regardless of HLC physical time.
    expect(drained).toEqual(changes);
    expect(isQueueEmpty(remaining)).toBe(true);
  });

  it('drain preserves seq continuity for changes enqueued afterwards', () => {
    const q = enqueueAll(emptySyncQueue(), [change('a', 1), change('b', 2)]);
    const { remaining } = drain(q);

    const next = enqueue(remaining, change('c', 3));
    // seq keeps climbing so post-drain submission order stays consistent.
    expect(pendingEntries(next).map((e) => e.seq)).toEqual([2]);
  });

  it('acknowledge removes only the acknowledged seqs and keeps the rest ordered', () => {
    const q = enqueueAll(emptySyncQueue(), [
      change('a', 1),
      change('b', 2),
      change('c', 3),
    ]);

    // Simulate writing the first two, then a new change arriving.
    const snapshot = pendingEntries(q).slice(0, 2).map((e) => e.seq);
    const withNew = enqueue(q, change('d', 4));
    const after = acknowledge(withNew, snapshot);

    expect(pendingChanges(after).map((c) => c.itemId)).toEqual(['c', 'd']);
  });

  it('acknowledge with no seqs returns the queue unchanged', () => {
    const q = enqueue(emptySyncQueue(), change('a', 1));
    expect(acknowledge(q, [])).toBe(q);
  });

  it('acknowledge ignores unknown seqs', () => {
    const q = enqueue(emptySyncQueue(), change('a', 1));
    const after = acknowledge(q, [999]);
    expect(pendingChanges(after).map((c) => c.itemId)).toEqual(['a']);
  });
});
