import { describe, expect, it } from 'vitest';

import { resolveGameServerDevConfig } from './config-values';

describe('local game-server configuration', () => {
  it('requires an explicit dev admission key', () => {
    expect(resolveGameServerDevConfig({}, {})).toBeNull();
  });

  it('accepts localhost and private-LAN development endpoints', () => {
    expect(
      resolveGameServerDevConfig(
        {},
        {
          EXPO_PUBLIC_GAME_SERVER_URL: 'http://127.0.0.1:2567',
          EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY: 'local-only',
        },
      ),
    ).toEqual({ url: 'http://127.0.0.1:2567', admissionKey: 'local-only' });
    expect(
      resolveGameServerDevConfig(
        {},
        {
          EXPO_PUBLIC_GAME_SERVER_URL: 'http://192.168.1.20:2567/',
          EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY: 'local-only',
        },
      ),
    ).toEqual({ url: 'http://192.168.1.20:2567', admissionKey: 'local-only' });
  });

  it('rejects a public endpoint carrying the dev key', () => {
    expect(
      resolveGameServerDevConfig(
        {},
        {
          EXPO_PUBLIC_GAME_SERVER_URL: 'https://games.example.com',
          EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY: 'must-not-leak',
        },
      ),
    ).toBeNull();
  });
});
