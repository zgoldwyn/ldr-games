import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementalCatalogFingerprint } from '@ldr/core';

import {
  claimDevPlatformerSeat,
  connectToPlatformerRoom,
  createDevPlatformerSession,
  isExpiredSeatReservationError,
  isWaitingForPlatformerSessionError,
} from './elemental-online';

const config = { url: 'http://127.0.0.1:2567', admissionKey: 'local-key' } as const;
const catalogFingerprint = elementalCatalogFingerprint();
const access = {
  roomId: 'room-1',
  gameSessionId: 'game-1',
  role: 'ember' as const,
  catalogFingerprint,
  reservation: {
    name: 'elemental_platformer',
    roomId: 'room-1',
    processId: 'process-1',
    sessionId: 'seat-1',
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('local platformer admission client', () => {
  it('recognizes an expired single-use seat reservation', () => {
    expect(isExpiredSeatReservationError(new Error('seat reservation expired.'))).toBe(true);
    expect(isExpiredSeatReservationError(new Error('Room closed (4002)'))).toBe(true);
    expect(isExpiredSeatReservationError(new Error('network unavailable'))).toBe(false);
  });

  it('only treats the expected empty-session response as pollable', () => {
    expect(
      isWaitingForPlatformerSessionError(new Error('No local platformer session is waiting')),
    ).toBe(true);
    expect(isWaitingForPlatformerSessionError(new Error('Network request failed'))).toBe(false);
  });

  it('creates through the dev-only endpoint with its explicit key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => access,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createDevPlatformerSession(config, {
        gameSessionId: 'game-1',
        pairingId: 'pair-1',
        creatorAccountId: 'creator',
        linkedAccountId: 'partner',
        creatorRole: 'ember',
      }),
    ).resolves.toEqual(access);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:2567/dev/platformer-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-dev-admission-key': 'local-key' }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      catalogFingerprint,
    });
  });

  it('claims the linked seat by pairing and actual account id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => access });
    vi.stubGlobal('fetch', fetchMock);

    await claimDevPlatformerSeat(config, 'pair-1', 'partner');

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      pairingId: 'pair-1',
      accountId: 'partner',
      catalogFingerprint,
    });
  });

  it('surfaces the server failure message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'No local platformer session is waiting' }),
      }),
    );

    await expect(claimDevPlatformerSeat(config, 'pair-1', 'partner')).rejects.toThrow(
      'No local platformer session is waiting',
    );
  });

  it('rejects a successful response from an old or mismatched server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...access, catalogFingerprint: 'different-levels' }),
      }),
    );

    await expect(claimDevPlatformerSeat(config, 'pair-1', 'partner')).rejects.toThrow(
      'Reload or update the app',
    );
  });

  it('rejects cached stale access before opening a room connection', async () => {
    await expect(
      connectToPlatformerRoom(config, { ...access, catalogFingerprint: 'stale-catalog' }),
    ).rejects.toThrow('Reload or update the app');
  });
});
