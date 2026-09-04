import { describe, expect, it } from 'vitest';

import { createAuthStorage, REFRESH_TOKEN_KEY } from './auth-storage';
import type { StringStore } from './string-store';

function memoryStore(): StringStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe('createAuthStorage', () => {
  it('keeps the refresh token in the secure store and the rest in bulk storage', async () => {
    const secure = memoryStore();
    const bulk = memoryStore();
    const storage = createAuthStorage(secure, bulk);

    await storage.setItem(
      'sb-auth-token',
      JSON.stringify({ access_token: 'access', refresh_token: 'refresh-secret', expires_at: 9 }),
    );

    expect(secure.data.get(REFRESH_TOKEN_KEY)).toBe('refresh-secret');
    expect(JSON.parse(bulk.data.get('sb-auth-token') ?? '{}').refresh_token).toBeUndefined();
    expect(JSON.parse(bulk.data.get('sb-auth-token') ?? '{}').access_token).toBe('access');

    const restored = await storage.getItem('sb-auth-token');
    expect(JSON.parse(restored ?? '{}')).toEqual({
      access_token: 'access',
      refresh_token: 'refresh-secret',
      expires_at: 9,
    });
  });

  it('clears the refresh token when supabase removes the session', async () => {
    const secure = memoryStore();
    const bulk = memoryStore();
    const storage = createAuthStorage(secure, bulk);

    await storage.setItem('sb-auth-token', JSON.stringify({ refresh_token: 'refresh-secret' }));
    await storage.removeItem('sb-auth-token');

    expect(secure.data.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(bulk.data.has('sb-auth-token')).toBe(false);
  });
});
