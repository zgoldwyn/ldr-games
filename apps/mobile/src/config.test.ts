import { describe, expect, it } from 'vitest';

import { resolveSupabaseConfig } from './config-values';

describe('Supabase mobile configuration', () => {
  it('uses the app target ahead of local shell environment values', () => {
    expect(
      resolveSupabaseConfig(
        { supabaseUrl: 'https://hosted.example', supabaseAnonKey: 'hosted-key' },
        {
          EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
          EXPO_PUBLIC_SUPABASE_ANON_KEY: 'local-key',
        },
      ),
    ).toEqual({ url: 'https://hosted.example', anonKey: 'hosted-key' });
  });

  it('falls back to app config for builds without environment overrides', () => {
    expect(
      resolveSupabaseConfig(
        { supabaseUrl: 'https://hosted.example', supabaseAnonKey: 'hosted-key' },
        {},
      ),
    ).toEqual({ url: 'https://hosted.example', anonKey: 'hosted-key' });
  });

  it('rejects a configuration without an anonymous key', () => {
    expect(resolveSupabaseConfig({}, {})).toBeNull();
  });
});
