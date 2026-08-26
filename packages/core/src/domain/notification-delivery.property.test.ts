import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { accountId, notificationId } from './common.js';
import type { Timestamp } from './common.js';
import type {
  Notification,
  NotificationCategory,
  NotificationSettings,
} from './notification.js';
import {
  NOTIFICATION_RETENTION_MS,
  isCategoryEnabled,
  isDuplicate,
  isExpired,
  shouldDeliver,
} from './notification-delivery.js';

/**
 * Property 39: Notification delivery eligibility (Req 11.3, 11.4, 11.5, 11.6).
 *
 * For any notification and recipient settings, the notification is eligible for
 * delivery to a session if and only if its category is enabled in the
 * recipient's settings (Req 11.3), it has not been acknowledged (Req 11.6), and
 * it is within the 30-day retention window from its creation (Req 11.4, 11.5).
 * Once acknowledged or once older than 30 days it is never delivered in any
 * subsequent session, regardless of the session's clock.
 *
 * **Validates: Requirements 11.3, 11.4, 11.5, 11.6**
 */

const CATEGORIES: readonly NotificationCategory[] = [
  'pairing',
  'game_invite',
  'async_turn',
  'reminder',
  'quiz',
  'system',
];

/** Recipient identity kept small so duplicate dedupe keys actually collide. */
const recipientArb = fc
  .constantFrom('alice', 'bob', 'carol')
  .map((raw) => accountId(raw));

const categoryArb = fc.constantFrom(...CATEGORIES);

/** A plausible creation time anchored from the epoch through the far future. */
const createdAtArb = fc.integer({ min: 0, max: 4_000_000_000_000 });

/**
 * A notification generator. `acknowledgedAt` is null roughly half the time and
 * otherwise a timestamp at/after creation, exercising both delivery states.
 */
function notificationArb(): fc.Arbitrary<Notification> {
  return fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 12 }).map((raw) => notificationId(raw)),
      recipientAccountId: recipientArb,
      category: categoryArb,
      createdAt: createdAtArb,
      dedupeKey: fc.constantFrom('evt-1', 'evt-2', 'evt-3'),
      acknowledgedAt: fc.option(fc.integer({ min: 0, max: 5_000_000_000_000 }), {
        nil: null,
      }),
    })
    .map((r) => ({
      id: r.id,
      recipientAccountId: r.recipientAccountId,
      category: r.category,
      payload: null,
      createdAt: r.createdAt,
      dedupeKey: r.dedupeKey,
      acknowledgedAt: r.acknowledgedAt,
      deliveredAt: null,
    }));
}

/** Settings whose disabled set is an arbitrary subset of the categories. */
function settingsArb(recipient: NotificationSettings['accountId']): fc.Arbitrary<NotificationSettings> {
  return fc
    .subarray(CATEGORIES as NotificationCategory[])
    .map((disabledCategories) => ({ accountId: recipient, disabledCategories }));
}

describe('Property 39: Notification delivery eligibility', () => {
  // Feature: ldr-companion-app, Property 39: Notification delivery eligibility
  it('is deliverable iff its category is enabled and it is unacknowledged (Req 11.3, 11.6)', () => {
    fc.assert(
      fc.property(
        notificationArb().chain((n) =>
          settingsArb(n.recipientAccountId).map((settings) => ({ n, settings })),
        ),
        ({ n, settings }) => {
          const enabled = !settings.disabledCategories.includes(n.category);
          const unacknowledged = n.acknowledgedAt === null;

          // shouldDeliver must agree exactly with the enabled-and-unacknowledged rule.
          expect(shouldDeliver(n, settings)).toBe(enabled && unacknowledged);
          // isCategoryEnabled is the category half of that rule.
          expect(isCategoryEnabled(n, settings)).toBe(enabled);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 39: Notification delivery eligibility
  it('is expired iff more than 30 days have elapsed since creation (Req 11.4, 11.5)', () => {
    fc.assert(
      fc.property(
        notificationArb(),
        // A non-negative elapsed delta spanning well inside to well past the window.
        fc.integer({ min: 0, max: NOTIFICATION_RETENTION_MS * 3 }),
        (n, delta) => {
          const now: Timestamp = n.createdAt + delta;
          expect(isExpired(n, now)).toBe(delta > NOTIFICATION_RETENTION_MS);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 39: Notification delivery eligibility
  it('is eligible iff enabled, unacknowledged, and within retention — never otherwise (Req 11.3-11.6)', () => {
    fc.assert(
      fc.property(
        notificationArb().chain((n) =>
          settingsArb(n.recipientAccountId).map((settings) => ({ n, settings })),
        ),
        fc.integer({ min: 0, max: NOTIFICATION_RETENTION_MS * 3 }),
        ({ n, settings }, delta) => {
          const now: Timestamp = n.createdAt + delta;
          const enabled = !settings.disabledCategories.includes(n.category);
          const unacknowledged = n.acknowledgedAt === null;
          const withinRetention = delta <= NOTIFICATION_RETENTION_MS;

          const eligible = shouldDeliver(n, settings) && !isExpired(n, now);

          // The full eligibility biconditional from Property 39.
          expect(eligible).toBe(enabled && unacknowledged && withinRetention);

          // Once acknowledged, it is never eligible in any session (any clock).
          if (!unacknowledged) expect(eligible).toBe(false);
          // Once past the retention window, it is never eligible either.
          if (!withinRetention) expect(eligible).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 39: Notification delivery eligibility
  it('treats two notifications as duplicates iff same recipient and same dedupeKey (Req 11.6)', () => {
    fc.assert(
      fc.property(notificationArb(), notificationArb(), (a, b) => {
        const sameIdentity =
          a.recipientAccountId === b.recipientAccountId && a.dedupeKey === b.dedupeKey;
        expect(isDuplicate(a, b)).toBe(sameIdentity);
        // Duplication is reflexive and symmetric.
        expect(isDuplicate(a, a)).toBe(true);
        expect(isDuplicate(a, b)).toBe(isDuplicate(b, a));
      }),
      { numRuns: 300 },
    );
  });
});
