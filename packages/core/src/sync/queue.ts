/**
 * Offline synchronization queue (Requirement 5.4).
 *
 * When a client loses connectivity it keeps mutating shared data locally. Each
 * mutation is an HLC-stamped {@link DataChange} that must be retained — in the
 * exact order it was submitted — until connectivity is restored and the change
 * is drained onto the write path. Nothing may be lost or reordered while
 * offline (Property 17).
 *
 * The queue is modeled as an **immutable value**: every operation returns a new
 * {@link SyncQueue} rather than mutating in place. This keeps the logic pure and
 * deterministic so it can be property-tested and shared unchanged between the
 * mobile and desktop shells. A monotonically increasing `seq` is assigned to
 * every entry on enqueue; submission order is therefore recoverable and stable
 * even across an in-flight drain that overlaps with new enqueues.
 *
 * This module owns only the in-memory queue data structure and its operations.
 * Connectivity detection, the connectivity-lost indicator, and the reconnect
 * drain wiring live in the Connection Manager (task 14.2); conflict resolution
 * by HLC happens on the write path (tasks 4.1 / 14.1), not here.
 */
import type { DataChange } from '../domain/sync.js';

/**
 * A {@link DataChange} together with the monotonic sequence number it was
 * assigned when enqueued. `seq` defines submission order and uniquely
 * identifies the entry for acknowledgement after a drain.
 */
export interface QueuedChange {
  readonly change: DataChange;
  readonly seq: number;
}

/**
 * An immutable snapshot of the offline sync queue. `entries` are held in
 * submission (ascending `seq`) order; `nextSeq` is the sequence number that
 * will be handed to the next enqueued change.
 */
export interface SyncQueue {
  readonly entries: readonly QueuedChange[];
  readonly nextSeq: number;
}

/** The result of draining the queue: the drained changes plus what remains. */
export interface DrainResult {
  /** Drained changes in submission order, ready for the write path. */
  readonly changes: readonly DataChange[];
  /** The queue with the drained entries removed. */
  readonly remaining: SyncQueue;
}

/** Create an empty queue. Sequence numbering starts at 0. */
export function emptySyncQueue(): SyncQueue {
  return { entries: [], nextSeq: 0 };
}

/**
 * Append a single change to the tail of the queue, preserving submission order,
 * and assign it the next sequence number. Returns a new queue; the input is
 * left unchanged.
 */
export function enqueue(queue: SyncQueue, change: DataChange): SyncQueue {
  return {
    entries: [...queue.entries, { change, seq: queue.nextSeq }],
    nextSeq: queue.nextSeq + 1,
  };
}

/**
 * Append several changes in the given order, assigning each the next sequence
 * number. Equivalent to folding {@link enqueue} over `changes`.
 */
export function enqueueAll(queue: SyncQueue, changes: readonly DataChange[]): SyncQueue {
  return changes.reduce(enqueue, queue);
}

/** The number of changes currently retained in the queue. */
export function queueSize(queue: SyncQueue): number {
  return queue.entries.length;
}

/** True when the queue holds no changes. */
export function isQueueEmpty(queue: SyncQueue): boolean {
  return queue.entries.length === 0;
}

/**
 * Return the retained changes in submission order **without removing them**.
 * Use this to inspect what is pending; the queue is unchanged.
 */
export function pendingChanges(queue: SyncQueue): readonly DataChange[] {
  return queue.entries.map((entry) => entry.change);
}

/**
 * Return the retained entries (change + `seq`) in submission order without
 * removing them. Callers that need to acknowledge specific entries after a
 * successful write use the returned `seq` values with {@link acknowledge}.
 */
export function pendingEntries(queue: SyncQueue): readonly QueuedChange[] {
  return queue.entries;
}

/**
 * Drain the queue: return every retained change in submission order and a
 * `remaining` queue with those entries removed. Sequence numbering continues
 * from where it left off, so changes enqueued after the drain keep a submission
 * order that is consistent with everything that came before.
 *
 * Draining is the only operation that removes changes, satisfying "retain until
 * connectivity is restored" (Req 5.4): a change stays queued until it is
 * explicitly drained here.
 */
export function drain(queue: SyncQueue): DrainResult {
  return {
    changes: pendingChanges(queue),
    remaining: { entries: [], nextSeq: queue.nextSeq },
  };
}

/**
 * Remove only the entries whose `seq` is in `drainedSeqs`, keeping everything
 * else. This supports a safe two-phase drain where new changes may be enqueued
 * while an earlier batch is still being written: snapshot with
 * {@link pendingEntries}, write, then acknowledge exactly the seqs that
 * succeeded. Entries that were not acknowledged remain retained and ordered.
 */
export function acknowledge(queue: SyncQueue, drainedSeqs: Iterable<number>): SyncQueue {
  const acked = new Set(drainedSeqs);
  if (acked.size === 0) {
    return queue;
  }
  return {
    entries: queue.entries.filter((entry) => !acked.has(entry.seq)),
    nextSeq: queue.nextSeq,
  };
}
