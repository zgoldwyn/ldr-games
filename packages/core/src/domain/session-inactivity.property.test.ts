import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { Timestamp } from './common.js';
import { INACTIVITY_LIMIT_MS, isWithinInactivityWindow } from './session-epoch.js';

/**
 * Property 9: Session inactivity expiry (Req 2.6).
 *
 * For any last-activity time delta, a session (whose token matches the
 * registry) is valid if and only if the delta between `now` and the last
 * activity time is strictly less than 30 days. This exercises the pure
 * inactivity evaluator {@link isWithinInactivityWindow} across a wide range of
 * deltas, including the exact 30-day boundary and one millisecond either side.
 *
 * **Validates: Requirements 2.6**
 */
describe('Property 9: Session inactivity expiry', () => {
  // Feature: ldr-companion-app, Property 9: Session inactivity expiry
  it('is valid iff the last-activity delta is strictly less than 30 days', () => {
    fc.assert(
      fc.property(
        // A plausible reference "now" anchored around the Unix epoch through
        // the far future, and a non-negative elapsed delta that ranges from
        // well inside the window to well past it.
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: INACTIVITY_LIMIT_MS * 3 }),
        (now: Timestamp, delta: number) => {
          const lastActivityAt: Timestamp = now - delta;
          const valid = isWithinInactivityWindow(lastActivityAt, now);
          // The evaluator must agree exactly with the strict-less-than rule.
          expect(valid).toBe(delta < INACTIVITY_LIMIT_MS);
        },
      ),
      { numRuns: 500 },
    );
  });

  // Feature: ldr-companion-app, Property 9: Session inactivity expiry
  it('handles the 30-day boundary precisely', () => {
    const now: Timestamp = 1_700_000_000_000;
    // One millisecond before the limit: still within the window.
    expect(isWithinInactivityWindow(now - (INACTIVITY_LIMIT_MS - 1), now)).toBe(true);
    // Exactly at the limit: expired (strictly-less-than rule excludes equality).
    expect(isWithinInactivityWindow(now - INACTIVITY_LIMIT_MS, now)).toBe(false);
    // One millisecond past the limit: expired.
    expect(isWithinInactivityWindow(now - (INACTIVITY_LIMIT_MS + 1), now)).toBe(false);
  });
});
