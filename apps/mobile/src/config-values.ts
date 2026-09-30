import type { GameServerDevConfig, SupabaseConfig } from './config';

function configuredValue(fromExtra: unknown, fromEnvironment: unknown): string {
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return typeof fromEnvironment === 'string' ? fromEnvironment : '';
}

export function resolveSupabaseConfig(
  configuredExtra: Record<string, unknown>,
  environment: Record<string, string | undefined>,
): SupabaseConfig | null {
  const url =
    configuredValue(configuredExtra.supabaseUrl, environment.EXPO_PUBLIC_SUPABASE_URL) ||
    'http://127.0.0.1:54321';
  const anonKey = configuredValue(
    configuredExtra.supabaseAnonKey,
    environment.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  );
  if (anonKey.length === 0) return null;
  return { url, anonKey };
}

function isLocalGameServerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
    const match = /^172\.(\d{1,2})\./.exec(host);
    return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  } catch {
    return false;
  }
}

export function resolveGameServerDevConfig(
  configuredExtra: Record<string, unknown>,
  environment: Record<string, string | undefined>,
): GameServerDevConfig | null {
  const url =
    configuredValue(configuredExtra.gameServerUrl, environment.EXPO_PUBLIC_GAME_SERVER_URL) ||
    'http://127.0.0.1:2567';
  const admissionKey = configuredValue(
    configuredExtra.gameServerDevAdmissionKey,
    environment.EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY,
  );
  if (admissionKey.length === 0 || !isLocalGameServerUrl(url)) return null;
  return { url: url.replace(/\/$/, ''), admissionKey };
}
