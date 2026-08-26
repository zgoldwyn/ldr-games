// Feature: ldr-companion-app, Property 40: Pairing-ended notification is delivered or deferred
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { accountId, pairingId, type Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Pairing } from './pairing.js';
import type { Notification, NotificationSettings } from './notification.js';
import { dissolvePairing } from './pairing-logic.js';
import {
  NOTIFICATION_RETENTION_MS,
  isExpired,
  shouldDeliver,
} from './notification-delivery.js';

/**
 * Property 40 (task 10.8) — Pairing-ended notification is delivered or deferred.
 *
 * For any pairing dissolution, `dissolvePairing` produces exactly one
 * pairing-ended notification for each former partner (Req 4.2). Each such
 * notification starts life deferred (`deliveredAt: null`) and is delivered at
 * the first moment its recipient has an authenticated session:
 *
 *  - a partner who already has an active session at dissolution receives it
 *    immediately (Req 4.2); and
 *  - a partner with no session at dissolution receives it when they next
 *    establish one (Req 4.5),
 *
 * both subject to the 30-day retention window: a deferred notification whose
 * next session falls outside the window is discarded rather than delivered
 * (Req 11.4/11.5, referenced by 4.5's "when that Partner next establishes ...").
 *
 * Delivery is modelled with the shared, pure eligibility helpers
 * (`shouldDeliver` + `isExpired`) so this test asserts the same delivery
 * decision the client and Edge Function make, without any I/O or clock access.
 */
describe('pairing-ended notification delivery / deferral (property)', () => {
  /** An active pairing, its two distinct members, and per-partner session facts. */
  interface Scenario {
    readonly pairing: Pairing;
    readonly memberA: Account;
    readonly memberB: Account;
    /** Whether each member has an active session at the moment of dissolution. */
    readonly activeAtDissolution: readonly [boolean, boolean];
    /**
     * For a member with no active session, how long after dissolution they next
     * establish one. Spans both inside and outside the retention window so both
     * "delivered later" and "discarded" outcomes are exercised.
     */
    readonly nextSessionDelay: readonly [number, number];
    /** Reference "now" at which dissolution happens (stamps the notifications). */
    readonly now: Timestamp;
    readonly settings: NotificationSettings;
  }

  const scenarioArb: fc.Arbitrary<Scenario> = fc
    .record({
      pairingRaw: fc.string({ minLength: 1, maxLength: 12 }),
      idA: fc.string({ minLength: 1, maxLength: 12 }),
      idB: fc.string({ minLength: 1, maxLength: 12 }),
      emailA: fc.emailAddress(),
      emailB: fc.emailAddress(),
      pairingCreatedAt: fc.integer({ min: 0, max: 1_000_000_000 }),
      now: fc.integer({ min: 0, max: 2_000_000_000 }),
      activeA: fc.boolean(),
      activeB: fc.boolean(),
      // 0 .. ~2x retention so delays straddle the 30-day window on both sides.
      delayA: fc.integer({ min: 0, max: 2 * NOTIFICATION_RETENTION_MS }),
      delayB: fc.integer({ min: 0, max: 2 * NOTIFICATION_RETENTION_MS }),
      // The pairing category may or may not be disabled; a duplicate disabled
      // category is harmless. Delivery must still hinge on session + retention.
      disablePairing: fc.boolean(),
    })
    // Keep the two members distinct so their notifications can be told apart.
    .filter(({ idA, idB }) => idA !== idB)
    .map((r) => {
      const pid = pairingId(r.pairingRaw);
      const memberA: Account = {
        id: accountId(r.idA),
        email: r.emailA,
        pairingId: pid,
        createdAt: r.pairingCreatedAt,
      };
      const memberB: Account = {
        id: accountId(r.idB),
        email: r.emailB,
        pairingId: pid,
        createdAt: r.pairingCreatedAt,
      };
      const pairing: Pairing = {
        id: pid,
        memberA: memberA.id,
        memberB: memberB.id,
        createdAt: r.pairingCreatedAt,
        status: 'active',
      };
      const settings: NotificationSettings = {
        // Settings shape is per-recipient; delivery here is checked per member
        // by reusing the disabledCategories list for whichever member is under
        // test. `pairing` disabled means that member never receives it.
        accountId: memberA.id,
        disabledCategories: r.disablePairing ? ['pairing'] : [],
      };
      return {
        pairing,
        memberA,
        memberB,
        activeAtDissolution: [r.activeA, r.activeB] as const,
        nextSessionDelay: [r.delayA, r.delayB] as const,
        now: r.now,
        settings,
      };
    });

  // Feature: ldr-companion-app, Property 40: Pairing-ended notification is delivered or deferred
  // Validates: Requirements 4.2, 4.5
  it('produces one pairing-ended notification per former partner, delivered on next session within retention', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const result = dissolvePairing({
          pairing: s.pairing,
          memberA: s.memberA,
          memberB: s.memberB,
          now: s.now,
        });

        // Dissolving an active pairing always succeeds.
        expect(isOk(result)).toBe(true);
        if (!isOk(result)) return;

        const pairingEnded = result.value.notifications.filter(
          (n) => (n.payload as { type: string }).type === 'pairing_ended',
        );

        // Req 4.2 — exactly one pairing-ended notification per former partner,
        // addressed to each partner exactly once, in the `pairing` category.
        expect(pairingEnded).toHaveLength(2);
        const recipients = pairingEnded.map((n) => n.recipientAccountId);
        expect(new Set(recipients).size).toBe(2);
        expect(recipients).toContain(s.memberA.id);
        expect(recipients).toContain(s.memberB.id);

        const members = [s.memberA, s.memberB] as const;

        members.forEach((member, i) => {
          const notification = pairingEnded.find(
            (n) => n.recipientAccountId === member.id,
          ) as Notification;
          expect(notification).toBeDefined();
          expect(notification.category).toBe('pairing');
          // Stamped at dissolution and not yet acknowledged.
          expect(notification.createdAt).toBe(s.now);
          expect(notification.acknowledgedAt).toBeNull();
          // Req 4.5 — every pairing-ended notification is produced deferred; it
          // carries no delivery timestamp until a session actually receives it.
          expect(notification.deliveredAt).toBeNull();

          const settings: NotificationSettings = {
            ...s.settings,
            accountId: member.id,
          };
          const categoryEnabled = !settings.disabledCategories.includes('pairing');

          // The first moment this partner has an authenticated session: now, if
          // they were already active at dissolution (Req 4.2); otherwise the
          // time they next establish one (Req 4.5).
          const nextSessionAt = s.activeAtDissolution[i]
            ? s.now
            : s.now + s.nextSessionDelay[i];

          const withinRetention = !isExpired(notification, nextSessionAt);
          const delivered = shouldDeliver(notification, settings) && withinRetention;

          // The delivery decision is fully determined by: category enabled, not
          // acknowledged, and the next session falling inside the retention
          // window. A fresh, enabled notification delivers iff within retention.
          expect(delivered).toBe(categoryEnabled && withinRetention);

          if (s.activeAtDissolution[i] && categoryEnabled) {
            // Req 4.2 — a partner with an active session at dissolution is
            // delivered immediately (elapsed time is zero, always in-window).
            expect(delivered).toBe(true);
          }

          if (categoryEnabled) {
            // Req 4.5 — a deferred notification is delivered on the next session
            // iff that session occurs within the 30-day retention window.
            const elapsed = nextSessionAt - notification.createdAt;
            expect(delivered).toBe(elapsed <= NOTIFICATION_RETENTION_MS);
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
