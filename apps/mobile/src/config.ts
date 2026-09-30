import Constants from 'expo-constants';

import { resolveGameServerDevConfig, resolveSupabaseConfig } from './config-values';

/** What the shell needs to construct a supabase-js client. */
export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

export interface GameServerDevConfig {
  readonly url: string;
  readonly admissionKey: string;
}

function extra(): Record<string, unknown> {
  const value = Constants.expoConfig?.extra;
  return value !== undefined && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function publicEnvironment(): Record<string, string | undefined> {
  // Expo replaces direct EXPO_PUBLIC_* member access while bundling. Passing
  // `process.env` through wholesale leaves these values undefined on device.
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_GAME_SERVER_URL: process.env.EXPO_PUBLIC_GAME_SERVER_URL,
    EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY:
      process.env.EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY,
  };
}

/**
 * Resolve the local or hosted Supabase project.
 *
 * Defaults the URL to the local stack (`127.0.0.1:54321`) because the simulator
 * can reach it. The anon key has no safe default — a missing key is a
 * configuration error, not a guess. Hosted projects are `21B.1`.
 */
export function readSupabaseConfig(): SupabaseConfig | null {
  return resolveSupabaseConfig(extra(), publicEnvironment());
}

/**
 * Local-only bridge used until Supabase issues signed production tickets.
 *
 * This is intentionally gated by an explicit admission key and a private-network
 * URL in `resolveGameServerDevConfig`, rather than `__DEV__`. Physical-device
 * builds bundle JavaScript with `__DEV__` disabled even when they are installed
 * solely for local testing.
 */
export function readGameServerDevConfig(): GameServerDevConfig | null {
  return resolveGameServerDevConfig(extra(), publicEnvironment());
}
