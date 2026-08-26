/**
 * Property-based coverage for the account-lockout evaluator (Requirement 2.3).
 *
 * These properties exercise both directions of the Property 7 biconditional:
 * an account is locked for 15 minutes *if and only if* 5 consecutive failed
 * attempts fall within a 15-minute window and the lock has not yet expired.
 * Each scenario builds a fully controlled attempt history so the expected
 * lock outcome is unambiguous, then checks `computeLockout` against it.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { Timestamp } from './common.js';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  computeLockout,
  type AuthAttemptEvent,
} from './auth-lockout.js';

// A fixed, positive epoch base keeps all generated timestamps comfortably
// away from zero so offsets never produce negative instants.
const BASE: Timestamp = 1_700_000_000_000;

const fail = (at: Timestamp): AuthAttemptEvent => ({ at, success: false });
const ok = (at: Timestamp): AuthAttemptEvent => ({ at, success: true });

/** Arbitrary of `n` non-decreasing timestamps whose span is at most `maxSpan`. */
const sortedFailureTimes = (n: number, maxSpan: number): fc.Arbitrary<Timestamp[]> =>
  fc
    .array(fc.integer({ min: 0, max: maxSpan }), { minLength: n, maxLength: n })
    .map((offsets) => offsets.map((o) => BASE + o).sort((a, b) => a - b));

/** Attempts strictly after `now` — these must never influence the verdict. */
const attemptsAfter = (now: Timestamp): fc.Arbitrary<AuthAttemptEvent[]> =>
  fc.array(
    fc.record({
      at: fc.integer({ min: now + 1, max: now + 10 * LOCKOUT_WINDOW_MS }),
      success: fc.boolean(),
    }),
    { maxLength: 5 },
  );

describe('computeLockout (Requirement 2.3)', () => {
  // Feature: ldr-companion-app, Property 7: Account lockout after 5 failures in 15 minutes
  it('locks for exactly 15 minutes when 5 consecutive failures land within a 15-minute window', () => {
    fc.assert(
      fc.property(
        sortedFailureTimes(LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_MS),
        fc.integer({ min: 0, max: LOCKOUT_DURATION_MS - 1 }),
        fc.boolean(),
        attemptsAfter(BASE + LOCKOUT_WINDOW_MS + LOCKOUT_DURATION_MS),
        (failureTimes, sinceTrigger, reversed, ignored) => {
          const trigger = failureTimes[failureTimes.length - 1]!;
          const now = trigger + sinceTrigger;
          // Attempts after `now` must be ignored; the fifth failure triggers the lock.
          const history = [...failureTimes.map(fail), ...ignored.filter((a) => a.at > now)];
          const attempts = reversed ? history.reverse() : history;

          const status = computeLockout(attempts, now);

          expect(status.locked).toBe(true);
          expect(status.lockedUntil).toBe(trigger + LOCKOUT_DURATION_MS);
        },
      ),
    );
  });

  // Feature: ldr-companion-app, Property 7: Account lockout after 5 failures in 15 minutes
  it('does not lock when fewer than 5 failures have occurred', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: LOCKOUT_THRESHOLD - 1 }).chain((n) =>
          sortedFailureTimes(n, 10 * LOCKOUT_WINDOW_MS),
        ),
        fc.integer({ min: 0, max: 10 * LOCKOUT_WINDOW_MS }),
        (failureTimes, extra) => {
          const now = (failureTimes[failureTimes.length - 1] ?? BASE) + extra;
          const status = computeLockout(failureTimes.map(fail), now);
          expect(status.locked).toBe(false);
          expect(status.lockedUntil).toBeNull();
        },
      ),
    );
  });

  // Feature: ldr-companion-app, Property 7: Account lockout after 5 failures in 15 minutes
  it('does not lock when a success breaks the failure streak below the threshold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: LOCKOUT_THRESHOLD - 1 }),
        fc.integer({ min: 1, max: LOCKOUT_THRESHOLD - 1 }),
        fc.integer({ min: 0, max: 10 * LOCKOUT_WINDOW_MS }),
        (before, after, extra) => {
          // A single success sits between two runs of failures, each shorter
          // than the threshold, so no window of 5 consecutive failures exists.
          const events: AuthAttemptEvent[] = [];
          let t = BASE;
          for (let i = 0; i < before; i += 1) events.push(fail((t += 1)));
          events.push(ok((t += 1)));
          for (let i = 0; i < after; i += 1) events.push(fail((t += 1)));
          const now = t + extra;

          const status = computeLockout(events, now);
          expect(status.locked).toBe(false);
          expect(status.lockedUntil).toBeNull();
        },
      ),
    );
  });

  // Feature: ldr-companion-app, Property 7: Account lockout after 5 failures in 15 minutes
  it('does not lock when 5 consecutive failures span more than the 15-minute window', () => {
    fc.assert(
      fc.property(
        // Three interior offsets inside the over-wide span; the run is anchored
        // at BASE and at BASE + WINDOW + overshoot, guaranteeing span > WINDOW.
        fc.integer({ min: 1, max: LOCKOUT_WINDOW_MS }),
        fc.array(fc.integer({ min: 0, max: LOCKOUT_WINDOW_MS }), {
          minLength: LOCKOUT_THRESHOLD - 2,
          maxLength: LOCKOUT_THRESHOLD - 2,
        }),
        fc.integer({ min: 0, max: LOCKOUT_DURATION_MS }),
        (overshoot, interior, sinceLast) => {
          const last = BASE + LOCKOUT_WINDOW_MS + overshoot;
          const failureTimes = [BASE, ...interior.map((o) => BASE + o), last].sort(
            (a, b) => a - b,
          );
          const now = last + sinceLast;

          const status = computeLockout(failureTimes.map(fail), now);
          expect(status.locked).toBe(false);
          expect(status.lockedUntil).toBeNull();
        },
      ),
    );
  });

  // Feature: ldr-companion-app, Property 7: Account lockout after 5 failures in 15 minutes
  it('unlocks once 15 minutes have elapsed since the fifth failure', () => {
    fc.assert(
      fc.property(
        sortedFailureTimes(LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_MS),
        fc.integer({ min: 0, max: 10 * LOCKOUT_WINDOW_MS }),
        (failureTimes, past) => {
          const trigger = failureTimes[failureTimes.length - 1]!;
          const now = trigger + LOCKOUT_DURATION_MS + past; // at or after expiry
          const status = computeLockout(failureTimes.map(fail), now);
          expect(status.locked).toBe(false);
          expect(status.lockedUntil).toBeNull();
        },
      ),
    );
  });
});
