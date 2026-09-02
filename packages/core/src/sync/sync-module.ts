/**
 * Client Sync Module: pairing-scoped Postgres Changes, the connectivity-lost
 * indicator, and the reconnect queue drain (Requirements 5.3, 5.4, 5.5).
 *
 * This is the client half of the sync path. The server half is the `sync-write`
 * Edge Function (task 14.1), which is where last-write-wins conflict resolution
 * actually happens. That split is deliberate and load-bearing: per design.md,
 * `resolveConflict` is applied SERVER-side so a stale offline write cannot
 * clobber a newer value. This module therefore never resolves a conflict itself
 * — it posts changes and reports back whatever the server decided, including
 * `superseded: true` when last-write-wins kept a newer value (Req 5.5, 5.6).
 *
 * Responsibilities, mapped to the requirements:
 *
 *   5.3  `subscribe(pairingId)` opens a Postgres Changes subscription filtered to
 *        the pairing, so a partner's committed change reaches this client. The
 *        "<5 seconds" budget is a property of Realtime delivery, asserted at the
 *        integration layer (task 14.3), not something client code enforces.
 *   5.4  While offline, mutations are retained in the {@link SyncQueue} in
 *        submission order and the connectivity-lost indicator is visible.
 *        Going offline is NOT an error: `applyChange` succeeds by queueing.
 *   5.5  On the offline -> online edge, the queue drains. Drained changes go to
 *        the write path oldest-HLC-first (the Edge Function re-sorts, but sending
 *        in order keeps the request comprehensible), in batches, and only the
 *        entries the server confirmed are removed from the queue.
 *
 * COLLABORATOR INJECTION. The module takes narrow function-typed ports rather
 * than a `SupabaseClient`. Two reasons: it keeps the orchestration logic (which
 * has all the interesting edges — queue-vs-send, drain-once-per-reconnect,
 * partial acknowledgement) unit-testable without a live stack, and it lets task
 * 21.3 compose this into the full Connection Manager alongside Broadcast and
 * Presence without reaching through a client it does not own.
 * `createSupabaseSyncPorts` in `./supabase-ports.js` builds the real ports.
 *
 * OUT OF SCOPE, by design:
 *   - Broadcast / Presence channels and displacement sign-out — task 21.3.
 *   - Caching remote rows for offline reads (the Local Store) — task 21.2. This
 *     module hands remote changes to an `onRemoteChange` listener instead of
 *     caching them, so it does not pre-empt that decision.
 */
import type { PairingId } from '../domain/common.js';
import type { AppliedChange, DataChange } from '../domain/sync.js';
import {
  acknowledge,
  emptySyncQueue,
  enqueue,
  isQueueEmpty,
  pendingChanges,
  pendingEntries,
  queueSize,
  type SyncQueue,
} from './queue.js';
import {
  initialConnectivity,
  isOffline,
  isReconnection,
  observeConnectivity,
  type ChannelStatus,
  type Connectivity,
  type ConnectivityObservation,
  type ConnectivityState,
} from './connectivity.js';

/**
 * Maximum changes per write-path request. Mirrors `MAX_BATCH_SIZE` in the
 * `sync-write` Edge Function; a longer queue is drained across several requests
 * rather than being rejected with BATCH_TOO_LARGE.
 */
export const MAX_DRAIN_BATCH = 200;

/**
 * The budget a reconnect drain must finish within (Req 5.5: "within 10 seconds
 * of connectivity restoration"). Exceeding it does not throw — the remaining
 * changes stay queued for the next attempt, which is the correct behavior for a
 * flaky link — but it is reported on the {@link DrainOutcome} so a shell or a
 * test can see the budget was missed.
 */
export const DRAIN_BUDGET_MS = 10_000;

/** A committed change observed on the pairing's Postgres Changes subscription. */
export interface RemoteChange {
  /** Postgres operation that produced the row event. */
  readonly event: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Table the row belongs to, e.g. `relationship_dates`. */
  readonly table: string;
  /** The row as delivered by Realtime (new row, or old row for DELETE). */
  readonly row: Readonly<Record<string, unknown>>;
}

/** What a drain attempt did. */
export interface DrainOutcome {
  /** Server-reported results, in the order the changes were submitted. */
  readonly applied: readonly AppliedChange[];
  /** Changes still queued afterward (a failed batch, or newly enqueued work). */
  readonly remaining: number;
  /** Wall-clock duration of the drain. */
  readonly durationMs: number;
  /** True when the drain finished inside {@link DRAIN_BUDGET_MS} (Req 5.5). */
  readonly withinBudget: boolean;
}

/**
 * Injected collaborators. Each is the narrowest thing the module needs, so a
 * test can supply a plain function.
 */
export interface SyncPorts {
  /**
   * Open a pairing-scoped Postgres Changes subscription. Implementations must
   * filter server-side by `pairing_id` so this client is never delivered another
   * pairing's rows. Returns an unsubscribe function.
   */
  readonly subscribePairing: (
    pairingId: PairingId,
    handlers: {
      readonly onChange: (change: RemoteChange) => void;
      readonly onStatus: (status: ChannelStatus) => void;
    },
  ) => () => void;

  /**
   * POST changes to the `sync-write` Edge Function. Resolves with one
   * {@link AppliedChange} per submitted change, in submission order. Must REJECT
   * on a transport failure so the module can keep the batch queued — resolving
   * with a partial result would silently drop changes.
   */
  readonly postChanges: (changes: readonly DataChange[]) => Promise<readonly AppliedChange[]>;

  /** Clock, injected so drain timing is testable. */
  readonly now: () => number;
}

/** Optional listeners a shell or a later module (21.2/21.3) can attach. */
export interface SyncListeners {
  /** A partner's committed change arrived (Req 5.3). */
  readonly onRemoteChange?: (change: RemoteChange) => void;
  /** Connectivity changed; drives the indicator (Req 5.4). */
  readonly onConnectivityChange?: (state: ConnectivityState) => void;
  /** A reconnect drain finished (Req 5.5). */
  readonly onDrain?: (outcome: DrainOutcome) => void;
}

/** The client-facing sync surface (design.md `SyncModule`, extended). */
export interface SyncModule {
  /** Subscribe to the pairing's committed changes (Req 5.3). */
  subscribe(pairingId: PairingId): void;
  /** Tear down the subscription. */
  unsubscribe(): void;
  /**
   * Submit one change. Online, it goes straight to the write path. Offline, it
   * is queued and retained in submission order (Req 5.4) — which is reported as
   * a SUCCESS, not a failure, because losing connectivity must not fail a user's
   * action.
   */
  applyChange(change: DataChange): Promise<ApplyOutcome>;
  /** Drain the queue now. Called automatically on reconnect (Req 5.5). */
  drainQueue(): Promise<DrainOutcome>;
  /** Feed in a connectivity observation (e.g. a platform network event). */
  observe(observation: ConnectivityObservation): void;
  /** Current connectivity, including the indicator flag (Req 5.4). */
  connectivity(): ConnectivityState;
  /** Changes awaiting a drain, in submission order. */
  pending(): readonly DataChange[];
  /** How many changes are queued. */
  pendingCount(): number;
}

/** The result of {@link SyncModule.applyChange}. */
export type ApplyOutcome =
  /** Sent and decided by the server. `superseded` reflects last-write-wins. */
  | { readonly kind: 'applied'; readonly applied: AppliedChange }
  /**
   * Retained locally: either the client is offline, or the send failed and the
   * change was kept rather than lost (Req 5.4).
   */
  | { readonly kind: 'queued'; readonly queuedCount: number };

/**
 * Build a Sync Module over the given ports.
 *
 * The returned object owns mutable state (the queue, connectivity, the active
 * subscription). The pure pieces it folds over — {@link SyncQueue} and
 * {@link ConnectivityState} — remain immutable values, so the interesting logic
 * stays independently testable.
 */
export function createSyncModule(ports: SyncPorts, listeners: SyncListeners = {}): SyncModule {
  let queue: SyncQueue = emptySyncQueue();
  let connectivity: ConnectivityState = initialConnectivity(ports.now());
  let teardown: (() => void) | null = null;
  /** Guards against two overlapping drains double-submitting a change. */
  let draining = false;

  function setConnectivity(observation: ConnectivityObservation): void {
    const before = connectivity;
    const after = observeConnectivity(before, observation, ports.now());
    if (after === before) return;

    connectivity = after;
    listeners.onConnectivityChange?.(after);

    // Req 5.5: reconnection is the trigger, and only on the edge — so a drain
    // runs once per reconnect rather than on every online observation.
    if (isReconnection(before, after) && !isQueueEmpty(queue)) {
      void drainQueue();
    }
  }

  /**
   * Post one batch and remove exactly the entries the server confirmed.
   *
   * Acknowledging by `seq` rather than clearing the queue is what makes a drain
   * safe against concurrent enqueues: a change submitted by the user mid-drain
   * keeps its place and is not discarded by a batch it was never part of.
   */
  async function submitBatch(
    batch: readonly { readonly change: DataChange; readonly seq: number }[],
  ): Promise<readonly AppliedChange[]> {
    const applied = await ports.postChanges(batch.map((entry) => entry.change));
    // Only acknowledge as far as the server actually reported. A short response
    // leaves the unreported tail queued rather than dropping it.
    const confirmed = batch.slice(0, applied.length).map((entry) => entry.seq);
    queue = acknowledge(queue, confirmed);
    return applied;
  }

  async function drainQueue(): Promise<DrainOutcome> {
    const started = ports.now();

    // A drain already in flight owns the queue; report current state instead of
    // racing it.
    if (draining) {
      return {
        applied: [],
        remaining: queueSize(queue),
        durationMs: 0,
        withinBudget: true,
      };
    }

    draining = true;
    const applied: AppliedChange[] = [];
    try {
      // Re-read `pendingEntries` each pass so changes enqueued during the drain
      // are picked up, and so an unacknowledged batch is retried rather than
      // spun on forever.
      let guard = 0;
      while (!isQueueEmpty(queue)) {
        const batch = pendingEntries(queue).slice(0, MAX_DRAIN_BATCH);
        const before = queueSize(queue);
        const results = await submitBatch(batch);
        applied.push(...results);

        // No progress (server confirmed nothing) — stop rather than loop. The
        // changes stay queued for the next reconnection.
        if (queueSize(queue) >= before) break;

        // Defensive bound: with MAX_DRAIN_BATCH progress per pass this cannot be
        // reached in practice, but it guarantees termination.
        if (++guard > 1000) break;

        // Respect the budget: stop cleanly and leave the rest queued rather than
        // blocking the client past 10s (Req 5.5).
        if (ports.now() - started >= DRAIN_BUDGET_MS) break;
      }
    } catch {
      // Transport failure: everything unacknowledged stays queued (Req 5.4).
      // Treat it as a connectivity signal so the indicator is shown and the next
      // reconnection retries.
      setConnectivityWithoutDrain('offline');
    } finally {
      draining = false;
    }

    const durationMs = ports.now() - started;
    const outcome: DrainOutcome = {
      applied,
      remaining: queueSize(queue),
      durationMs,
      withinBudget: durationMs < DRAIN_BUDGET_MS,
    };
    listeners.onDrain?.(outcome);
    return outcome;
  }

  /**
   * Record a connectivity change WITHOUT triggering a drain. Used from inside a
   * failed drain: marking offline there must not immediately schedule another
   * drain, or a persistently failing link would spin.
   */
  function setConnectivityWithoutDrain(status: Connectivity): void {
    const before = connectivity;
    const after = observeConnectivity(
      before,
      { kind: 'network', online: status === 'online' },
      ports.now(),
    );
    if (after === before) return;
    connectivity = after;
    listeners.onConnectivityChange?.(after);
  }

  return {
    subscribe(pairingId: PairingId): void {
      // Replace any existing subscription so re-subscribing cannot leak a
      // channel or deliver a former pairing's rows.
      teardown?.();
      teardown = ports.subscribePairing(pairingId, {
        onChange: (change) => listeners.onRemoteChange?.(change),
        onStatus: (status) => setConnectivity({ kind: 'channel', status }),
      });
    },

    unsubscribe(): void {
      teardown?.();
      teardown = null;
    },

    async applyChange(change: DataChange): Promise<ApplyOutcome> {
      // Req 5.4: offline mutations are retained, in order, and this is a success.
      if (isOffline(connectivity)) {
        queue = enqueue(queue, change);
        return { kind: 'queued', queuedCount: queueSize(queue) };
      }

      // If a drain is in flight, queue behind it so this change cannot overtake
      // earlier queued changes and land out of submission order.
      if (draining || !isQueueEmpty(queue)) {
        queue = enqueue(queue, change);
        return { kind: 'queued', queuedCount: queueSize(queue) };
      }

      try {
        const [applied] = await ports.postChanges([change]);
        if (!applied) {
          queue = enqueue(queue, change);
          return { kind: 'queued', queuedCount: queueSize(queue) };
        }
        return { kind: 'applied', applied };
      } catch {
        // The write failed in transit. Retain it (Req 5.4) and show the
        // indicator; the next reconnection drains it.
        queue = enqueue(queue, change);
        setConnectivityWithoutDrain('offline');
        return { kind: 'queued', queuedCount: queueSize(queue) };
      }
    },

    drainQueue,

    observe(observation: ConnectivityObservation): void {
      setConnectivity(observation);
    },

    connectivity(): ConnectivityState {
      return connectivity;
    },

    pending(): readonly DataChange[] {
      return pendingChanges(queue);
    },

    pendingCount(): number {
      return queueSize(queue);
    },
  };
}
