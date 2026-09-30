export interface GameServerConfig {
  readonly port: number;
  readonly host: string;
  readonly devAdmissionEnabled: boolean;
  readonly devAdmissionKey: string | null;
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? '2567');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function readGameServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GameServerConfig {
  const devAdmissionEnabled = env.GAME_SERVER_ENABLE_DEV_ADMISSION === 'true';
  const devAdmissionKey = env.GAME_SERVER_DEV_ADMISSION_KEY?.trim() || null;

  if (devAdmissionEnabled && env.NODE_ENV === 'production') {
    throw new Error('GAME_SERVER_ENABLE_DEV_ADMISSION cannot be enabled in production');
  }
  if (devAdmissionEnabled && devAdmissionKey === null) {
    throw new Error('GAME_SERVER_DEV_ADMISSION_KEY is required when dev admission is enabled');
  }

  return {
    port: parsePort(env.PORT),
    // Binding explicitly avoids Node choosing an IPv6-only socket on some Macs.
    // It also lets physical devices on the local network reach the dev server.
    host: env.GAME_SERVER_HOST?.trim() || '0.0.0.0',
    devAdmissionEnabled,
    devAdmissionKey,
  };
}
