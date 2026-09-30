import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountProfile } from '../domain/account.js';
import type { AccountId } from '../domain/common.js';
import type { ProfilePorts } from './profile-module.js';

interface ProfileRow {
  readonly account_id: string;
  readonly display_name: string;
  readonly updated_at: string;
}

function fromRow(row: ProfileRow): AccountProfile {
  return {
    accountId: row.account_id as AccountId,
    displayName: row.display_name,
    updatedAt: Date.parse(row.updated_at),
  };
}

export function createSupabaseProfilePorts(client: SupabaseClient): ProfilePorts {
  return {
    async fetchEmail() {
      const { data, error } = await client.auth.getUser();
      return error === null ? (data.user?.email ?? null) : null;
    },

    async fetchProfiles(accountIds) {
      const { data, error } = await client
        .from('account_profiles')
        .select('account_id, display_name, updated_at')
        .in('account_id', [...accountIds]);
      if (error !== null) return [];
      return (data as ProfileRow[]).map(fromRow);
    },

    async saveDisplayName(accountId, displayName) {
      const { data, error } = await client
        .from('account_profiles')
        .upsert(
          {
            account_id: accountId,
            display_name: displayName,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'account_id' },
        )
        .select('account_id, display_name, updated_at')
        .single();
      return error === null
        ? { ok: true, value: fromRow(data as ProfileRow) }
        : { ok: false, message: 'Your display name could not be saved. Please try again.' };
    },

    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      return error === null
        ? { ok: true, value: undefined }
        : { ok: false, message: 'Your password could not be reset. Please try again.' };
    },
  };
}
