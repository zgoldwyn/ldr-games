// Unit tests for the pure Presence evaluation behind the real-time pause
// transition (Req 6.6).
//
// The session transitions themselves (`pauseSession` / `resumeSession`) are
// property-tested in `@ldr/core` (Property 21, task 5.5). These tests cover the
// only new decision in task 15.2: turning a Presence snapshot into "this partner
// has been gone for 30 continuous seconds", plus the derived notification.
//
// Run with: deno test supabase/functions/_shared/rt-presence.test.ts
import { assertEquals } from "std/assert/mod.ts";
import {
  DISCONNECT_THRESHOLD_MS,
  findDisconnectedMember,
  isDisconnected,
  offlineDurationMs,
  pausedNotification,
  remainingMember,
} from "./rt-presence.ts";

const NOW = 1_700_000_000_000;
const MEMBERS = { a: "account-a", b: "account-b" };

Deno.test("an online partner is never counted as absent", () => {
  const sample = { accountId: MEMBERS.a, online: true, lastSeenAt: NOW - 60_000 };
  assertEquals(offlineDurationMs(sample, NOW), 0);
  assertEquals(isDisconnected(sample, NOW), false);
});

Deno.test("a future lastSeenAt cannot manufacture a disconnect", () => {
  const sample = { accountId: MEMBERS.a, online: false, lastSeenAt: NOW + 60_000 };
  assertEquals(offlineDurationMs(sample, NOW), 0);
  assertEquals(isDisconnected(sample, NOW), false);
});

Deno.test("29.999s absence does not pause, exactly 30s does", () => {
  const justUnder = {
    accountId: MEMBERS.b,
    online: false,
    lastSeenAt: NOW - (DISCONNECT_THRESHOLD_MS - 1),
  };
  const atThreshold = {
    accountId: MEMBERS.b,
    online: false,
    lastSeenAt: NOW - DISCONNECT_THRESHOLD_MS,
  };
  assertEquals(isDisconnected(justUnder, NOW), false);
  assertEquals(isDisconnected(atThreshold, NOW), true);
});

Deno.test("findDisconnectedMember picks the 30s-absent partner", () => {
  const samples = [
    { accountId: MEMBERS.a, online: true, lastSeenAt: NOW },
    { accountId: MEMBERS.b, online: false, lastSeenAt: NOW - 45_000 },
  ];
  assertEquals(findDisconnectedMember(samples, MEMBERS, NOW), MEMBERS.b);
  assertEquals(remainingMember(MEMBERS, MEMBERS.b), MEMBERS.a);
});

Deno.test("a member without a sample is not treated as disconnected", () => {
  const samples = [{ accountId: MEMBERS.a, online: true, lastSeenAt: NOW }];
  assertEquals(findDisconnectedMember(samples, MEMBERS, NOW), null);
});

Deno.test("samples from outside the pairing are ignored", () => {
  const samples = [
    { accountId: "stranger", online: false, lastSeenAt: NOW - 120_000 },
  ];
  assertEquals(findDisconnectedMember(samples, MEMBERS, NOW), null);
});

Deno.test("the pause notification targets the remaining partner", () => {
  const notification = pausedNotification({
    recipient: MEMBERS.a,
    sessionId: "session-1",
    gameId: "tic-tac-toe",
    disconnectedPartner: MEMBERS.b,
    pausedSince: NOW,
  });

  assertEquals(notification.recipient_account_id, MEMBERS.a);
  assertEquals(notification.category, "system");
  assertEquals(
    notification.dedupe_key,
    `rt-session-paused:session-1:${NOW}:${MEMBERS.a}`,
  );
});
