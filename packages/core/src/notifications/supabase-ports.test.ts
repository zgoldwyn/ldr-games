import { describe, expect, it } from 'vitest';

import { accountId } from '../domain/common.js';
import { notificationSettingsFromRow } from './supabase-ports.js';

const ALICE = accountId('11111111-1111-4111-8111-111111111111');

describe('notification-settings Supabase mapping', () => {
  it('maps nullable arrays and native APNs registration into a canonical domain shape', () => {
    expect(
      notificationSettingsFromRow({
        account_id: ALICE,
        disabled_categories: ['quiz', 'pairing', 'quiz', 'not-a-category'],
        apns_device_token: 'a'.repeat(64),
        apns_environment: 'development',
      }),
    ).toEqual({
      accountId: ALICE,
      disabledCategories: ['pairing', 'quiz'],
      apnsDeviceToken: 'a'.repeat(64),
      apnsEnvironment: 'development',
    });
    expect(
      notificationSettingsFromRow({
        account_id: ALICE,
        disabled_categories: null,
        apns_device_token: null,
        apns_environment: null,
      }),
    ).toEqual({ accountId: ALICE, disabledCategories: [] });
  });
});
