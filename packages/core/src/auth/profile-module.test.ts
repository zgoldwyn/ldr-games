import { describe, expect, it, vi } from 'vitest';

import { accountId } from '../domain/common.js';
import { createProfileModule, type ProfilePorts } from './profile-module.js';

const SELF = accountId('11111111-1111-4111-8111-111111111111');
const PARTNER = accountId('22222222-2222-4222-8222-222222222222');

function ports(overrides: Partial<ProfilePorts> = {}): ProfilePorts {
  return {
    fetchEmail: async () => 'alex@example.com',
    fetchProfiles: async () => [
      { accountId: SELF, displayName: 'Alex', updatedAt: 1 },
      { accountId: PARTNER, displayName: 'Sam', updatedAt: 2 },
    ],
    saveDisplayName: async (accountId, displayName) => ({
      ok: true,
      value: { accountId, displayName, updatedAt: 3 },
    }),
    updatePassword: async () => ({ ok: true, value: undefined }),
    ...overrides,
  };
}

describe('ProfileModule', () => {
  it('loads the signed-in email and both paired display names', async () => {
    const result = await createProfileModule(ports()).getDetails(SELF, PARTNER);
    expect(result).toEqual({
      ok: true,
      value: {
        email: 'alex@example.com',
        selfProfile: { accountId: SELF, displayName: 'Alex', updatedAt: 1 },
        partnerProfile: { accountId: PARTNER, displayName: 'Sam', updatedAt: 2 },
      },
    });
  });

  it('normalizes a display name before saving it', async () => {
    const saveDisplayName = vi.fn<ProfilePorts['saveDisplayName']>(async (accountId, name) => ({
      ok: true,
      value: { accountId, displayName: name, updatedAt: 3 },
    }));
    const result = await createProfileModule(ports({ saveDisplayName })).saveDisplayName(
      SELF,
      '  Alex   Rivera  ',
    );
    expect(result.ok).toBe(true);
    expect(saveDisplayName).toHaveBeenCalledWith(SELF, 'Alex Rivera');
  });

  it('rejects empty and oversized display names without a write', async () => {
    const saveDisplayName = vi.fn<ProfilePorts['saveDisplayName']>();
    const module = createProfileModule(ports({ saveDisplayName }));
    expect((await module.saveDisplayName(SELF, '   ')).ok).toBe(false);
    expect((await module.saveDisplayName(SELF, 'x'.repeat(41))).ok).toBe(false);
    expect(saveDisplayName).not.toHaveBeenCalled();
  });

  it('enforces the shared password policy before updating Supabase Auth', async () => {
    const updatePassword = vi.fn<ProfilePorts['updatePassword']>(async () => ({
      ok: true,
      value: undefined,
    }));
    const module = createProfileModule(ports({ updatePassword }));
    expect((await module.resetPassword('too-short')).ok).toBe(false);
    expect(updatePassword).not.toHaveBeenCalled();
    expect((await module.resetPassword('Str0ng!Password')).ok).toBe(true);
    expect(updatePassword).toHaveBeenCalledWith('Str0ng!Password');
  });
});
