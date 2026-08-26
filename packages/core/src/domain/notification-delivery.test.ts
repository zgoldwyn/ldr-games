import { describe, expect, it } from 'vitest';

import { accountId, notificationId } from './common.js';
import type { Notification, NotificationCategory, NotificationSettings } from './notification.js';
import {
  NOTIFICATION_RETENTION_MS,
  dedupeIdentity,
  isCategoryEnabled,
  isDuplicate,
  isExpired,
  shouldDeliver,
} from './notification-delivery.js';

const RECIPIENT = accountId('recipient');
const CREATED_AT = 1_000_000_000_000;

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: notificationId('n1'),
    recipientAccountId: RECIPIENT,
    category: 'game_invite',
    payload: null,
    createdAt: CREATED_AT,
    dedupeKey: 'evt-1',
    acknowledgedAt: null,
    deliveredAt: null,
    ...overrides,
  };
}

function makeSettings(
  disabledCategories: readonly NotificationCategory[] = [],
): NotificationSettings {
  return { accountId: RECIPIENT, disabledCategories };
}

describe('isCategoryEnabled', () => {
  it('is enabled when the category is not disabled', () => {
    expect(isCategoryEnabled(makeNotification(), makeSettings())).toBe(true);
  });

  it('is disabled when the category is in disabledCategories', () => {
    expect(
      isCategoryEnabled(makeNotification({ category: 'reminder' }), makeSettings(['reminder'])),
    ).toBe(false);
  });
});

describe('shouldDeliver', () => {
  it('delivers an unacknowledged notification whose category is enabled', () => {
    expect(shouldDeliver(makeNotification(), makeSettings())).toBe(true);
  });

  it('withholds a notification whose category is disabled (Req 11.3)', () => {
    expect(
      shouldDeliver(makeNotification({ category: 'quiz' }), makeSettings(['quiz'])),
    ).toBe(false);
  });

  it('withholds an acknowledged notification (Req 11.6)', () => {
    expect(
      shouldDeliver(makeNotification({ acknowledgedAt: CREATED_AT + 1 }), makeSettings()),
    ).toBe(false);
  });

  it('withholds when both disabled and acknowledged', () => {
    expect(
      shouldDeliver(
        makeNotification({ category: 'system', acknowledgedAt: CREATED_AT + 1 }),
        makeSettings(['system']),
      ),
    ).toBe(false);
  });
});

describe('isExpired', () => {
  it('is not expired at creation time', () => {
    expect(isExpired(makeNotification(), CREATED_AT)).toBe(false);
  });

  it('is not expired exactly at the 30-day boundary', () => {
    expect(isExpired(makeNotification(), CREATED_AT + NOTIFICATION_RETENTION_MS)).toBe(false);
  });

  it('is expired one millisecond past 30 days (Req 11.5)', () => {
    expect(isExpired(makeNotification(), CREATED_AT + NOTIFICATION_RETENTION_MS + 1)).toBe(true);
  });
});

describe('dedupe handling', () => {
  it('treats same recipient + same dedupeKey as duplicates (Req 11.6)', () => {
    const a = makeNotification({ id: notificationId('a') });
    const b = makeNotification({ id: notificationId('b') });
    expect(isDuplicate(a, b)).toBe(true);
  });

  it('treats different dedupeKeys as distinct', () => {
    const a = makeNotification({ dedupeKey: 'evt-1' });
    const b = makeNotification({ dedupeKey: 'evt-2' });
    expect(isDuplicate(a, b)).toBe(false);
  });

  it('treats different recipients with the same key as distinct', () => {
    const a = makeNotification();
    const b = makeNotification({ recipientAccountId: accountId('other') });
    expect(isDuplicate(a, b)).toBe(false);
    expect(dedupeIdentity(a)).not.toBe(dedupeIdentity(b));
  });
});
