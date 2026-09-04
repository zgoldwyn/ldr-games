import Constants from 'expo-constants';

/** What the shell needs to construct a supabase-js client. */
export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

function extra(): Record<string, unknown> {
  const value = Constants.expoConfig?.extra;
  return value !== undefined && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function read(name: 'supabaseUrl' | 'supabaseAnonKey', envName: string): string {
  const fromExtra = extra()[name];
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' ? fromEnv : '';
}

/**
 * Resolve the local or hosted Supabase project.
 *
 * Defaults the URL to the local stack (`127.0.0.1:54321`) because the simulator
 * can reach it. The anon key has no safe default — a missing key is a
 * configuration error, not a guess. Hosted projects are `21B.1`.
 */
export function readSupabaseConfig(): SupabaseConfig | null {
  const url = read('supabaseUrl', 'EXPO_PUBLIC_SUPABASE_URL') || 'http://127.0.0.1:54321';
  const anonKey = read('supabaseAnonKey', 'EXPO_PUBLIC_SUPABASE_ANON_KEY');
  if (anonKey.length === 0) return null;
  return { url, anonKey };
}
