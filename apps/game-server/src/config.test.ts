import { describe, expect, it } from 'vitest';

import { readGameServerConfig } from './config.js';

describe('game-server configuration', () => {
  it('defaults to local port 2567 with dev admission disabled', () => {
    expect(readGameServerConfig({})).toEqual({
      port: 2567,
      host: '0.0.0.0',
      devAdmissionEnabled: false,
      devAdmissionKey: null,
    });
  });

  it('accepts an explicit bind host', () => {
    expect(readGameServerConfig({ GAME_SERVER_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('requires an explicit key for the dev-only admission route', () => {
    expect(() => readGameServerConfig({ GAME_SERVER_ENABLE_DEV_ADMISSION: 'true' })).toThrow(
      'GAME_SERVER_DEV_ADMISSION_KEY',
    );
  });

  it('refuses to expose dev admission in production', () => {
    expect(() =>
      readGameServerConfig({
        NODE_ENV: 'production',
        GAME_SERVER_ENABLE_DEV_ADMISSION: 'true',
        GAME_SERVER_DEV_ADMISSION_KEY: 'test-only',
      }),
    ).toThrow('cannot be enabled in production');
  });
});
