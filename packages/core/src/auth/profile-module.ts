import type { AccountId } from '../domain/common.js';
import type { AccountProfile } from '../domain/account.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  isValidDisplayName,
  normalizeDisplayName,
} from '../domain/account.js';
import { validatePasswordPolicy } from '../domain/auth-validation.js';

export interface AccountDetails {
  readonly email: string;
  readonly selfProfile: AccountProfile | null;
  readonly partnerProfile: AccountProfile | null;
}

export type ProfileResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface ProfilePorts {
  readonly fetchEmail: () => Promise<string | null>;
  readonly fetchProfiles: (accountIds: readonly AccountId[]) => Promise<readonly AccountProfile[]>;
  readonly saveDisplayName: (
    accountId: AccountId,
    displayName: string,
  ) => Promise<ProfileResult<AccountProfile>>;
  readonly updatePassword: (password: string) => Promise<ProfileResult<void>>;
}

export interface ProfileModule {
  getDetails(self: AccountId, partner?: AccountId): Promise<ProfileResult<AccountDetails>>;
  saveDisplayName(self: AccountId, displayName: string): Promise<ProfileResult<AccountProfile>>;
  resetPassword(password: string): Promise<ProfileResult<void>>;
}

export function createProfileModule(ports: ProfilePorts): ProfileModule {
  return {
    async getDetails(self, partner) {
      const email = await ports.fetchEmail();
      if (email === null) return { ok: false, message: 'Your account could not be loaded.' };

      const profiles = await ports.fetchProfiles(partner === undefined ? [self] : [self, partner]);
      return {
        ok: true,
        value: {
          email,
          selfProfile: profiles.find((profile) => profile.accountId === self) ?? null,
          partnerProfile:
            partner === undefined
              ? null
              : (profiles.find((profile) => profile.accountId === partner) ?? null),
        },
      };
    },

    async saveDisplayName(self, displayName) {
      const normalized = normalizeDisplayName(displayName);
      if (!isValidDisplayName(normalized)) {
        return {
          ok: false,
          message: `Enter a display name between 1 and ${DISPLAY_NAME_MAX_LENGTH} characters.`,
        };
      }
      return await ports.saveDisplayName(self, normalized);
    },

    async resetPassword(password) {
      const policy = validatePasswordPolicy(password);
      if (!policy.valid) {
        return {
          ok: false,
          message: 'Use 12–128 characters with uppercase, lowercase, a number, and a symbol.',
        };
      }
      return await ports.updatePassword(password);
    },
  };
}
