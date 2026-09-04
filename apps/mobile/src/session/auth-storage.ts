import type { StringStore } from './string-store';

/** Isolated SecureStore key for the Supabase refresh token (task 22.1b). */
export const REFRESH_TOKEN_KEY = 'ldr.refresh-token';

interface AuthJson {
  readonly refresh_token?: string;
  readonly [key: string]: unknown;
}

function asJson(value: string): AuthJson | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? (parsed as AuthJson) : null;
  } catch {
    return null;
  }
}

/**
 * supabase-js `auth.storage` adapter.
 *
 * WHY THE SPLIT. Task 22.1b puts the refresh token in SecureStore. The rest of
 * the supabase session blob (access token, user, expiry) is larger and not the
 * long-lived secret, so it lives in bulk storage (AsyncStorage). Reassembling
 * on read is what lets `getSession` restore a signed-in client after a cold start.
 */
export function createAuthStorage(secure: StringStore, bulk: StringStore) {
  return {
    async getItem(key: string): Promise<string | null> {
      const raw = await bulk.getItem(key);
      if (raw === null) return null;
      const parsed = asJson(raw);
      if (parsed === null) return raw;
      const refresh = await secure.getItem(REFRESH_TOKEN_KEY);
      if (refresh === null) return raw;
      return JSON.stringify({ ...parsed, refresh_token: refresh });
    },

    async setItem(key: string, value: string): Promise<void> {
      const parsed = asJson(value);
      if (parsed === null || typeof parsed.refresh_token !== 'string') {
        await bulk.setItem(key, value);
        return;
      }
      await secure.setItem(REFRESH_TOKEN_KEY, parsed.refresh_token);
      const { refresh_token: _refresh, ...rest } = parsed;
      await bulk.setItem(key, JSON.stringify(rest));
    },

    async removeItem(key: string): Promise<void> {
      await bulk.removeItem(key);
      await secure.removeItem(REFRESH_TOKEN_KEY);
    },
  };
}
