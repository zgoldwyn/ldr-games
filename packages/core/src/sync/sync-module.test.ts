import { describe, expect, it } from 'vitest';

import { accountId, pairingId as toPairingId } from '../domain/common.js';
import type { AppliedChange, DataChange } from '../domain/sync.js';
import type { ChannelStatus } from './connectivity.js';
import {
  createSyncModule,
  DRAIN_BUDGET_MS,
  MAX_DRAIN_BATCH,
  type DrainOutcome,
  type RemoteChange,
  type SyncPorts,
} from './sync-module.js';

// Unit tests for the client Sync Module (Req 5.3, 5.4, 5.5).
//
// These use hand-rolled ports rather than a Supabase client: the module exists to
// make the queue-vs-send, drain-once-per-reconnect, and partial-acknowledgement
// decisions, and those are what is worth pinning down. Realtime delivery latency
// and real conflict resolution are integration concerns (task 14.3).

const PAIRING = toPairingId('pair-1');
const ALICE = accountId('alice');

function change(itemId: string, physical = 1_000): DataChange {
  return {
    itemId,
    itemType: 'relationship_date',
    payload: { title: itemId },
    hlc: { physical, counter: 0, originAccountId: ALICE },
    originAccountId: ALICE,
  };
}

function appliedFor(c: DataChange, superseded = false): AppliedChange {
  return { change: c, appliedAt: 5_000, superseded };
}

/** A controllable test double for {@link SyncPorts}. */
function harness(
  options: {
    /** Per-call behaviour for postChanges; defaults to accepting everything. */
    post?: (changes: readonly DataChange[]) => Promise<readonly AppliedChange[]>;
    startOnline?: boolean;
  } = {},
) {
  let clock = 1_000;
  const submissions: readonly DataChange[][] = [];
  const pushed: DataChange[][] = submissions as DataChange[][];
  let statusHandler: ((s: ChannelStatus) => void) | null = null;
  let changeHandler: ((c: RemoteChange) => void) | null = null;
  let unsubscribed = 0;

  const ports: SyncPorts = {
    subscribePairing: (_pairing, handlers) => {
      statusHandler = handlers.onStatus;
      changeHandler = handlers.onChange;
      return () => {
        unsubscribed += 1;
      };
    },
    postChanges: async (changes) => {
      pushed.push([...changes]);
      if (options.post) return await options.post(changes);
      return changes.map((c) => appliedFor(c));
    },
    now: () => clock,
  };

  const drains: DrainOutcome[] = [];
  const remote: RemoteChange[] = [];
  const module = createSyncModule(ports, {
    onDrain: (o) => drains.push(o),
    onRemoteChange: (c) => remote.push(c),
  });

  if (options.startOnline) {
    module.subscribe(PAIRING);
    statusHandler?.('SUBSCRIBED');
  }

  return {
    module,
    drains,
    remote,
    batches: pushed,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (v: number) => {
      clock = v;
    },
    status: (s: ChannelStatus) => statusHandler?.(s),
    emit: (c: RemoteChange) => changeHandler?.(c),
    unsubscribeCount: () => unsubscribed,
    subscribe: () => module.subscribe(PAIRING),
  };
}

describe('Sync Module — connectivity and queueing (Req 5.4)', () => {
  it('queues a change while offline and reports success, not failure', async () => {
    const h = harness();
    // Never subscribed, so still offline.
    const outcome = await h.module.applyChange(change('d1'));

    // Losing connectivity must not fail the user's action.
    expect(outcome.kind).toBe('queued');
    expect(h.module.pendingCount()).toBe(1);
    expect(h.batches).toHaveLength(0);
    expect(h.module.connectivity().indicatorVisible).toBe(true);
  });

  it('retains queued changes in submission order', async () => {
    const h = harness();
    for (const id of ['d1', 'd2', 'd3']) {
      await h.module.applyChange(change(id));
    }
    expect(h.module.pending().map((c) => c.itemId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('sends immediately while online', async () => {
    const h = harness({ startOnline: true });
    const outcome = await h.module.applyChange(change('d1'));

    expect(outcome.kind).toBe('applied');
    expect(h.batches).toEqual([[change('d1')]]);
    expect(h.module.pendingCount()).toBe(0);
  });

  it('reports the server-side supersede decision rather than resolving locally', async () => {
    // Req 5.5/5.6: last-write-wins is applied server-side; the client only
    // reports what came back.
    const h = harness({
      startOnline: true,
      post: async (changes) => changes.map((c) => appliedFor(c, true)),
    });
    const outcome = await h.module.applyChange(change('d1'));

    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.applied.superseded).toBe(true);
    }
  });

  it('retains a change whose send fails in transit and shows the indicator', async () => {
    const h = harness({
      startOnline: true,
      post: async () => {
        throw new Error('network down');
      },
    });

    const outcome = await h.module.applyChange(change('d1'));
    // Not lost, and not surfaced as a hard failure.
    expect(outcome.kind).toBe('queued');
    expect(h.module.pending().map((c) => c.itemId)).toEqual(['d1']);
    expect(h.module.connectivity().indicatorVisible).toBe(true);
  });

  it('queues behind existing queued work instead of overtaking it', async () => {
    // Go offline, queue one change, come back online but block the drain so it is
    // still in flight when the next change is submitted.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness({
      post: async (changes) => {
        await gate;
        return changes.map((c) => appliedFor(c));
      },
    });

    await h.module.applyChange(change('first')); // offline -> queued
    h.subscribe();
    h.status('SUBSCRIBED'); // starts the drain, which now blocks on `gate`

    // Submitted mid-drain: must be queued, NOT sent immediately, or it would land
    // ahead of `first` and violate submission order.
    const mid = await h.module.applyChange(change('second'));
    expect(mid.kind).toBe('queued');
    expect(h.module.pending().map((c) => c.itemId)).toContain('second');

    release?.();
    await new Promise((r) => setTimeout(r, 0));
    await h.module.drainQueue();

    // Across the whole run, `first` reached the write path before `second`.
    const order = h.batches.flat().map((c) => c.itemId);
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('second'));
  });
});

describe('Sync Module — reconnect drain (Req 5.5)', () => {
  it('drains the queue on the offline -> online edge', async () => {
    const h = harness();
    await h.module.applyChange(change('d1'));
    await h.module.applyChange(change('d2'));
    expect(h.module.pendingCount()).toBe(2);

    h.subscribe();
    h.status('SUBSCRIBED');
    // The drain is kicked off without awaiting; let it settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(h.module.pendingCount()).toBe(0);
    expect(h.batches.flat().map((c) => c.itemId)).toEqual(['d1', 'd2']);
  });

  it('drains once per reconnection, not on every online observation', async () => {
    const h = harness();
    await h.module.applyChange(change('d1'));
    h.subscribe();

    h.status('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 0));
    const afterFirst = h.batches.length;

    // Repeated SUBSCRIBED is a level, not an edge.
    h.status('SUBSCRIBED');
    h.status('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 0));

    expect(h.batches.length).toBe(afterFirst);
  });

  it('does not drain on reconnect when the queue is empty', async () => {
    const h = harness();
    h.subscribe();
    h.status('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.batches).toHaveLength(0);
  });

  it('splits a long queue into batches the write path accepts', async () => {
    const h = harness();
    const total = MAX_DRAIN_BATCH + 25;
    for (let i = 0; i < total; i += 1) {
      await h.module.applyChange(change(`d${i}`));
    }

    h.subscribe();
    h.status('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 0));

    expect(h.batches).toHaveLength(2);
    expect(h.batches[0]).toHaveLength(MAX_DRAIN_BATCH);
    expect(h.batches[1]).toHaveLength(25);
    expect(h.module.pendingCount()).toBe(0);
  });

  it('keeps changes queued when the drain fails, losing nothing', async () => {
    const h = harness({
      post: async () => {
        throw new Error('still down');
      },
    });
    await h.module.applyChange(change('d1'));
    await h.module.applyChange(change('d2'));

    h.subscribe();
    h.status('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 0));

    // Retained, in order, for the next reconnection (Req 5.4).
    expect(h.module.pending().map((c) => c.itemId)).toEqual(['d1', 'd2']);
    expect(h.module.connectivity().indicatorVisible).toBe(true);
  });

  it('acknowledges only what the server confirmed, retrying the tail', async () => {
    // A server that confirms one change per request. The unreported tail must not
    // be acknowledged (that would drop it), and the drain should come back for it
    // rather than leaving it stranded.
    const h = harness({
      post: async (changes) => [appliedFor(changes[0] as DataChange)],
    });
    await h.module.applyChange(change('d1'));
    await h.module.applyChange(change('d2'));

    const outcome = await h.module.drainQueue();

    // Two requests: [d1,d2] confirmed d1 only, then [d2] confirmed d2.
    expect(h.batches.map((b) => b.map((c) => c.itemId))).toEqual([['d1', 'd2'], ['d2']]);
    expect(outcome.applied).toHaveLength(2);
    expect(h.module.pendingCount()).toBe(0);
  });

  it('stops rather than spinning when the server confirms nothing', async () => {
    const h = harness({ post: async () => [] });
    await h.module.applyChange(change('d1'));

    const outcome = await h.module.drainQueue();

    expect(outcome.applied).toHaveLength(0);
    expect(h.module.pendingCount()).toBe(1);
    // One attempt only — no infinite retry loop.
    expect(h.batches).toHaveLength(1);
  });

  it('reports whether the drain met the 10-second budget', async () => {
    const fast = harness();
    await fast.module.applyChange(change('d1'));
    const quick = await fast.module.drainQueue();
    expect(quick.withinBudget).toBe(true);
    expect(quick.remaining).toBe(0);

    // A drain that overruns is reported, not thrown, and leaves work queued.
    const slow = harness({
      post: async (changes) => {
        slow.advance(DRAIN_BUDGET_MS + 1);
        return changes.map((c) => appliedFor(c));
      },
    });
    for (let i = 0; i < MAX_DRAIN_BATCH + 1; i += 1) {
      await slow.module.applyChange(change(`d${i}`));
    }
    const overrun = await slow.module.drainQueue();
    expect(overrun.withinBudget).toBe(false);
    // Stopped at the budget instead of blocking the client, rest still queued.
    expect(overrun.remaining).toBeGreaterThan(0);
  });

  it('does not run two overlapping drains', async () => {
    const h = harness();
    await h.module.applyChange(change('d1'));

    const [first, second] = await Promise.all([
      h.module.drainQueue(),
      h.module.drainQueue(),
    ]);

    // Exactly one of them did the work; neither double-submitted.
    const did = [first, second].filter((o) => o.applied.length > 0);
    expect(did).toHaveLength(1);
    expect(h.batches).toHaveLength(1);
  });
});

describe('Sync Module — pairing subscription (Req 5.3)', () => {
  it('forwards a partner committed change to the listener', () => {
    const h = harness({ startOnline: true });
    const incoming: RemoteChange = {
      event: 'UPDATE',
      table: 'relationship_dates',
      row: { id: 'd1', title: 'Anniversary' },
    };
    h.emit(incoming);
    expect(h.remote).toEqual([incoming]);
  });

  it('replaces an existing subscription rather than leaking it', () => {
    const h = harness({ startOnline: true });
    expect(h.unsubscribeCount()).toBe(0);
    // Re-subscribing must tear the old channel down, or a former pairing's rows
    // could keep arriving.
    h.subscribe();
    expect(h.unsubscribeCount()).toBe(1);

    h.module.unsubscribe();
    expect(h.unsubscribeCount()).toBe(2);
  });

  it('drives connectivity from the channel status', () => {
    const h = harness();
    h.subscribe();
    expect(h.module.connectivity().status).toBe('offline');

    h.status('SUBSCRIBED');
    expect(h.module.connectivity().status).toBe('online');

    h.status('CHANNEL_ERROR');
    expect(h.module.connectivity().status).toBe('offline');
    expect(h.module.connectivity().indicatorVisible).toBe(true);
  });
});
