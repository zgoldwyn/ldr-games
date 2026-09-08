import { describe, expect, it } from 'vitest';

import { accountId } from '../domain/common.js';
import { notificationSettingsFromRow } from './supabase-ports.js';

const ALICE = accountId('11111111-1111-4111-8111-111111111111');

describe('notification-settings Supabase mapping', () => {
  it('maps nullable arrays and tokens into a canonical domain settings shape', () => {
    expect(
      notificationSettingsFromRow({
        account_id: ALICE,
        disabled_categories: ['quiz', 'pairing', 'quiz', 'not-a-category'],
        expo_push_token: 'ExponentPushToken[token]',
      }),
    ).toEqual({
      accountId: ALICE,
      disabledCategories: ['pairing', 'quiz'],
      expoPushToken: 'ExponentPushToken[token]',
    });
    expect(
      notificationSettingsFromRow({
        account_id: ALICE,
        disabled_categories: null,
        expo_push_token: null,
      }),
    ).toEqual({ accountId: ALICE, disabledCategories: [] });
  });
});
