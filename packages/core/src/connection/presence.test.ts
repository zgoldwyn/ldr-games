import { describe, expect, it } from 'vitest';

import { accountId as toAccountId } from '../domain/common.js';
import {
  absenceMs,
  applyPresenceJoin,
  applyPresenceLeave,
  applyPresenceSync,
  DISCONNECT_THRESHOLD_MS,
  emptyPresenceRoster,
  longestAbsenceMs,
  nextReportDelayMs,
  presenceSamples,
  PRESENCE_REPORT_INTERVAL_MS,
  shouldReportDisconnect,
} from './presence.js';

// Unit tests for client Presence tracking (Req 6.6).
//
// The server re-evaluates the 30-second rule and is the authority on pausing, so
// what matters here is that the client accumulates a CONTINUOUS absence and asks
// at the right moment. The failure mode these tests exist for is a roster that
// keeps refreshing `lastSeenAt` on every Realtime `sync` frame: the window then
// never accumulates, the report never fires, and a session never pauses.

const ME = toAccountId('11111111-1111-4111-8111-111111111111');
const PARTNER = toAccountId('22222222-2222-4222-8222-222222222222');
const T0 = 1_700_000_000_000;

/** A roster where both partners are present as of T0. */
function bothPresent() {
  return applyPresenceSync(emptyPresenceRoster(), [ME, PARTNER], T0);
}

describe('presence roster folding', () => {
  it('records both partners as online from a sync frame', () => {
    const roster = bothPresent();
    expect(presenceSamples(roster)).toHaveLength(2);
    expect(roster.members[PARTNER]?.online).toBe(true);
  });

  it('marks a known member absent when a sync frame omits them', () => {
    const roster = applyPresenceSync(bothPresent(), [ME], T0 + 1_000);
    expect(roster.members[PARTNER]?.online).toBe(false);
    expect(roster.members[PARTNER]?.lastSeenAt).toBe(T0 + 1_000);
  });

  it('adds an account seen for the first time in a sync frame', () => {
    const roster = applyPresenceSync(emptyPresenceRoster(), [PARTNER], T0);
    expect(roster.members[PARTNER]?.online).toBe(true);
  });

  it('marks a member absent on leave', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0 + 500);
    expect(roster.members[PARTNER]?.online).toBe(false);
    expect(roster.members[PARTNER]?.lastSeenAt).toBe(T0 + 500);
  });

  it('marks a member present again on join', () => {
    const left = applyPresenceLeave(bothPresent(), PARTNER, T0 + 500);
    const rejoined = applyPresenceJoin(left, PARTNER, T0 + 2_000);
    expect(rejoined.members[PARTNER]?.online).toBe(true);
  });
});

describe('continuous absence (Req 6.6)', () => {
  it('preserves the absence start across repeated sync frames', () => {
    // THE bug this module exists to avoid. Realtime re-emits `sync` often; if
    // each frame refreshed `lastSeenAt`, the 30-second window would restart
    // every few seconds and a disconnected partner would never pause the game.
    let roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    roster = applyPresenceSync(roster, [ME], T0 + 5_000);
    roster = applyPresenceSync(roster, [ME], T0 + 10_000);
    roster = applyPresenceSync(roster, [ME], T0 + 20_000);

    expect(roster.members[PARTNER]?.lastSeenAt).toBe(T0);
    expect(absenceMs(roster, PARTNER, T0 + 20_000)).toBe(20_000);
  });

  it('preserves the absence start across repeated leave events', () => {
    let roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    roster = applyPresenceLeave(roster, PARTNER, T0 + 9_000);
    expect(absenceMs(roster, PARTNER, T0 + 9_000)).toBe(9_000);
  });

  it('restarts the clock when the partner comes back', () => {
    // Req 6.6 is about CONTINUOUS disconnection: a partner who blinks out and
    // returns must not accumulate toward a pause.
    let roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    roster = applyPresenceJoin(roster, PARTNER, T0 + 25_000);
    roster = applyPresenceLeave(roster, PARTNER, T0 + 26_000);

    expect(absenceMs(roster, PARTNER, T0 + 30_000)).toBe(4_000);
    expect(shouldReportDisconnect(roster, ME, T0 + 30_000)).toBe(false);
  });

  it('reports zero absence for a present member', () => {
    expect(absenceMs(bothPresent(), PARTNER, T0 + 60_000)).toBe(0);
  });

  it('clamps a future lastSeenAt rather than reporting a negative absence', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0 + 10_000);
    expect(absenceMs(roster, PARTNER, T0)).toBe(0);
  });
});

describe('when to report (Req 6.6)', () => {
  it('does not report before the 30-second threshold', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    expect(shouldReportDisconnect(roster, ME, T0 + DISCONNECT_THRESHOLD_MS - 1)).toBe(false);
  });

  it('reports exactly at the threshold', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    // `>=`, matching the server's `isDisconnected`, so the two agree on the edge.
    expect(shouldReportDisconnect(roster, ME, T0 + DISCONNECT_THRESHOLD_MS)).toBe(true);
  });

  it('never reports on our own absence', () => {
    // A client cannot observe itself leaving, and reporting it would ask the
    // server to pause the game on the reporter.
    const roster = applyPresenceLeave(bothPresent(), ME, T0);
    expect(shouldReportDisconnect(roster, ME, T0 + 60_000)).toBe(false);
    expect(longestAbsenceMs(roster, ME, T0 + 60_000)).toBe(0);
  });
});

describe('report scheduling', () => {
  it('schedules nothing while both partners are present', () => {
    expect(nextReportDelayMs(bothPresent(), ME, T0)).toBeNull();
  });

  it('sleeps until the pause becomes due rather than polling', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    // One wake-up at +30s beats thirty wake-ups on a battery-powered phone.
    expect(nextReportDelayMs(roster, ME, T0)).toBe(DISCONNECT_THRESHOLD_MS);
    expect(nextReportDelayMs(roster, ME, T0 + 10_000)).toBe(DISCONNECT_THRESHOLD_MS - 10_000);
  });

  it('repeats on an interval once past the threshold', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0);
    // The first report can lose a race with a concurrent move or an in-flight
    // rejoin, so it is retried rather than fired once.
    expect(nextReportDelayMs(roster, ME, T0 + DISCONNECT_THRESHOLD_MS)).toBe(
      PRESENCE_REPORT_INTERVAL_MS,
    );
  });

  it('ignores our own absence when scheduling', () => {
    const roster = applyPresenceLeave(bothPresent(), ME, T0);
    expect(nextReportDelayMs(roster, ME, T0)).toBeNull();
  });
});

describe('the rt-presence request body', () => {
  it('carries every member with online and lastSeenAt', () => {
    const roster = applyPresenceLeave(bothPresent(), PARTNER, T0 + 1_000);
    const samples = presenceSamples(roster);

    // Exactly the shape `rt-presence` parses in `toSample`.
    expect(samples).toContainEqual({ accountId: ME, online: true, lastSeenAt: T0 });
    expect(samples).toContainEqual({
      accountId: PARTNER,
      online: false,
      lastSeenAt: T0 + 1_000,
    });
  });
});
