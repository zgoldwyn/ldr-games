// Unit tests for the pure lockout decision in the auth store (Req 2.3).
//
// These cover the only new logic in task 12.3: reconstructing the consecutive-
// failure event stream from the compact per-account aggregate and feeding it to
// the shared `computeLockout` evaluator. The evaluator itself is exhaustively
// property-tested in `@ldr/core` (Property 7, task 3.6); here we assert the
// aggregate bridge preserves the 5-in-15-minutes policy at its boundaries.
//
// Run with: deno test supabase/functions/_shared/auth-store.test.ts
import { assertEquals } from "std/assert/mod.ts";
import { decideLockout } from "./auth-store.ts";

const MINUTE = 60 * 1000;
const NOW = 1_700_000_000_000;

Deno.test("fewer than 5 failures never locks", () => {
  const status = decideLockout(
    { windowStart: NOW - 5 * MINUTE, failedCount: 4, lockedUntil: null },
    NOW,
  );
  assertEquals(status, { locked: false, lockedUntil: null });
});

Deno.test("5 failures within a 15-minute window locks for 15 minutes", () => {
  const windowStart = NOW - 10 * MINUTE;
  const status = decideLockout(
    { windowStart, failedCount: 5, lockedUntil: null },
    NOW,
  );
  assertEquals(status, { locked: true, lockedUntil: NOW + 15 * MINUTE });
});

Deno.test("5 failures spanning more than 15 minutes does not lock", () => {
  const windowStart = NOW - 20 * MINUTE;
  const status = decideLockout(
    { windowStart, failedCount: 5, lockedUntil: null },
    NOW,
  );
  assertEquals(status, { locked: false, lockedUntil: null });
});

Deno.test("a triggered lock is still in effect before it expires", () => {
  // 6th failure while the window is still open keeps the account locked.
  const windowStart = NOW - 12 * MINUTE;
  const status = decideLockout(
    { windowStart, failedCount: 6, lockedUntil: null },
    NOW,
  );
  assertEquals(status.locked, true);
  assertEquals(status.lockedUntil, NOW + 15 * MINUTE);
});
