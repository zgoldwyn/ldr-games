/**
 * Hybrid Logical Clock (HLC) and deterministic last-write-wins conflict
 * resolution (Requirements 5.5, 5.6).
 *
 * A plain wall-clock timestamp is not enough for last-write-wins: clocks drift,
 * two events can land on the same millisecond, and there is no way to break the
 * resulting tie the same way on every device. An HLC pairs physical wall-clock
 * time with a monotonic logical `counter` (so causally-ordered events on one
 * clock never collide even when physical time stands still or moves backwards)
 * and an `originAccountId` as the final deterministic tiebreaker. Together they
 * form a *total order* over changes, which is exactly what deterministic
 * convergence (Req 5.6) needs.
 *
 * The clock is modeled as a set of **pure functions** over an immutable
 * {@link HLCTimestamp} "clock state". Physical time is always passed in
 * (`physicalNow`) rather than read from `Date.now()` internally, so the logic is
 * fully deterministic and property-testable; the platform shells wrap these
 * with a real clock source.
 */
import type { AccountId } from './common.js';
import type { DataChange, HLCTimestamp } from './sync.js';

/**
 * Create the initial clock state for an account. `physical` starts at
 * `physicalNow` (defaulting to 0 so a clock can be created deterministically in
 * tests) with a zero counter.
 */
export function initialClock(
  originAccountId: AccountId,
  physicalNow = 0,
): HLCTimestamp {
  return { physical: physicalNow, counter: 0, originAccountId };
}

/**
 * Advance the clock for a **local event** (a local mutation or an outgoing
 * "send"). The physical component never moves backwards: it becomes
 * `max(state.physical, physicalNow)`. If wall-clock time advanced the counter
 * resets to 0; if it did not (same or stale physical reading) the counter
 * increments so the new timestamp still strictly follows the previous one.
 */
export function hlcLocalEvent(
  state: HLCTimestamp,
  physicalNow: number,
): HLCTimestamp {
  const physical = Math.max(state.physical, physicalNow);
  const counter = physical === state.physical ? state.counter + 1 : 0;
  return { physical, counter, originAccountId: state.originAccountId };
}

/**
 * Advance the clock on **receiving** a remote timestamp, merging causality from
 * the incoming `remote` HLC. The new physical component is the max of the local
 * clock, the remote clock, and the current wall clock; the counter is chosen so
 * the result strictly dominates both the previous local state and the received
 * timestamp:
 * - if physical time advanced past both, counter resets to 0;
 * - if it ties only the local clock, the local counter increments;
 * - if it ties only the remote clock, the remote counter increments;
 * - if it ties both, the greater of the two counters increments.
 *
 * The resulting timestamp keeps this clock's `originAccountId`.
 */
export function hlcReceiveEvent(
  state: HLCTimestamp,
  remote: HLCTimestamp,
  physicalNow: number,
): HLCTimestamp {
  const physical = Math.max(state.physical, remote.physical, physicalNow);
  let counter: number;
  if (physical === state.physical && physical === remote.physical) {
    counter = Math.max(state.counter, remote.counter) + 1;
  } else if (physical === state.physical) {
    counter = state.counter + 1;
  } else if (physical === remote.physical) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { physical, counter, originAccountId: state.originAccountId };
}

/**
 * Total order over HLC timestamps: compare by physical time, then by counter,
 * then by `originAccountId`. Returns a negative number when `a < b`, a positive
 * number when `a > b`, and 0 only when all three components are equal.
 *
 * The `originAccountId` tiebreaker is what makes the order *total* and
 * deterministic: two changes stamped on the same physical millisecond with the
 * same counter (produced by different accounts) still order the same way on
 * every device (Req 5.6).
 */
export function compareHLC(a: HLCTimestamp, b: HLCTimestamp): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.originAccountId !== b.originAccountId) {
    return a.originAccountId < b.originAccountId ? -1 : 1;
  }
  return 0;
}

/**
 * Deterministic last-write-wins resolution of two conflicting changes to the
 * same shared item (Requirements 5.5, 5.6). The winner is the change with the
 * greater HLC timestamp under {@link compareHLC} (physical time, then counter,
 * then origin account id).
 *
 * This is **symmetric** on ties: because the total order distinguishes any two
 * timestamps that differ in physical time, counter, or origin account id,
 * `resolveConflict(a, b)` and `resolveConflict(b, a)` always select the same
 * winning value, so both partners' sessions converge. When the two HLCs are
 * fully equal the changes are indistinguishable duplicates (a single HLC never
 * emits the same `(physical, counter)` twice for one origin), so returning
 * either is convergent.
 */
export function resolveConflict(a: DataChange, b: DataChange): DataChange {
  return compareHLC(b.hlc, a.hlc) > 0 ? b : a;
}
