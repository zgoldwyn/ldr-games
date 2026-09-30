import { describe, expect, it, vi } from 'vitest';

import type { PlatformerAdmission } from './admission.js';
import { PLATFORMER_CATALOG_FINGERPRINT } from './constants.js';
import {
  DevSessionProvisioner,
  type MatchMakerPort,
  type SeatReservation,
} from './provisioning.js';

function fakeMatchMaker(): MatchMakerPort & {
  createRoom: ReturnType<typeof vi.fn>;
  reserveSeatFor: ReturnType<typeof vi.fn>;
} {
  let seat = 0;
  return {
    createRoom: vi.fn(async () => ({ roomId: 'room-1' })),
    getRoomActivity: vi.fn(async () => ({ exists: true, clients: 1 })),
    reserveSeatFor: vi.fn(
      async (
        room: { roomId: string },
        _clientOptions: Record<string, never>,
        auth: PlatformerAdmission,
      ): Promise<SeatReservation> => ({
        roomId: room.roomId,
        sessionId: `seat-${(seat += 1)}`,
        auth,
      }),
    ),
  };
}

const request = {
  gameSessionId: 'game-1',
  pairingId: 'pairing-1',
  creatorAccountId: 'creator',
  linkedAccountId: 'partner',
  creatorRole: 'tide' as const,
  catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
};

describe('dev platformer session provisioning', () => {
  it('preserves the creator choice and assigns the partner the opposite role', async () => {
    const matchMaker = fakeMatchMaker();
    const provisioned = await new DevSessionProvisioner(matchMaker).provision(request);

    expect(provisioned.assignment).toMatchObject({
      creator: 'creator',
      creatorRole: 'tide',
      tide: 'creator',
      ember: 'partner',
    });
    expect(provisioned.creatorReservation.auth).toMatchObject({
      userId: 'creator',
      role: 'tide',
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
    });
    expect(provisioned.savedLevel).toBe(1);
    expect(matchMaker.createRoom).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ startLevel: 1 }),
    );
  });

  it('creates exactly one room for concurrent requests for the same game session', async () => {
    const matchMaker = fakeMatchMaker();
    const provisioner = new DevSessionProvisioner(matchMaker);

    const [first, second] = await Promise.all([
      provisioner.provision(request),
      provisioner.provision(request),
    ]);

    expect(first).toBe(second);
    expect(matchMaker.createRoom).toHaveBeenCalledTimes(1);
    expect(matchMaker.reserveSeatFor).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh reservation for either assigned account', async () => {
    const matchMaker = fakeMatchMaker();
    const provisioner = new DevSessionProvisioner(matchMaker);
    await provisioner.provision(request);

    const first = await provisioner.claimSeat(
      'pairing-1',
      'partner',
      PLATFORMER_CATALOG_FINGERPRINT,
    );
    const second = await provisioner.claimSeat(
      'pairing-1',
      'partner',
      PLATFORMER_CATALOG_FINGERPRINT,
    );
    await expect(
      provisioner.claimSeat('pairing-1', 'creator', PLATFORMER_CATALOG_FINGERPRINT),
    ).resolves.toMatchObject({
      gameSessionId: 'game-1',
      role: 'tide',
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
      reservation: { roomId: 'room-1' },
    });
    expect(first).toMatchObject({ gameSessionId: 'game-1', role: 'ember' });
    expect(second.reservation.sessionId).not.toBe(first.reservation.sessionId);
    expect(matchMaker.reserveSeatFor).toHaveBeenCalledTimes(4);
    await expect(
      provisioner.claimSeat('pairing-1', 'stranger', PLATFORMER_CATALOG_FINGERPRINT),
    ).rejects.toThrow('not assigned');
  });

  it('reports an active assigned session without consuming another seat', async () => {
    const matchMaker = fakeMatchMaker();
    const provisioner = new DevSessionProvisioner(matchMaker);
    await provisioner.provision(request);

    await expect(
      provisioner.getStatus('pairing-1', 'partner', PLATFORMER_CATALOG_FINGERPRINT),
    ).resolves.toEqual({
      active: true,
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
      role: 'ember',
      createdByYou: false,
      savedLevel: 1,
    });
    expect(matchMaker.reserveSeatFor).toHaveBeenCalledTimes(1);
  });

  it('identifies the creator and expires an abandoned room', async () => {
    vi.useFakeTimers();
    try {
      const matchMaker = fakeMatchMaker();
      matchMaker.getRoomActivity.mockResolvedValue({ exists: true, clients: 0 });
      const provisioner = new DevSessionProvisioner(matchMaker);
      await provisioner.provision(request);

      await expect(
        provisioner.getStatus('pairing-1', 'creator', PLATFORMER_CATALOG_FINGERPRINT),
      ).resolves.toMatchObject({
        active: true,
        createdByYou: true,
      });
      vi.advanceTimersByTime(20_001);
      await expect(
        provisioner.getStatus('pairing-1', 'creator', PLATFORMER_CATALOG_FINGERPRINT),
      ).resolves.toEqual({
        active: false,
        catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
        savedLevel: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects one account occupying both immutable seats', () => {
    const provisioner = new DevSessionProvisioner(fakeMatchMaker());
    expect(() =>
      provisioner.provision({ ...request, linkedAccountId: request.creatorAccountId }),
    ).toThrow('must be different');
  });

  it('rejects stale clients before creating or reserving a room', async () => {
    const matchMaker = fakeMatchMaker();
    const provisioner = new DevSessionProvisioner(matchMaker);

    expect(() =>
      provisioner.provision({ ...request, catalogFingerprint: 'stale-catalog' }),
    ).toThrow('Reload or update the app');
    await expect(provisioner.claimSeat('pairing-1', 'partner', 'stale-catalog')).rejects.toThrow(
      'Reload or update the app',
    );
    await expect(provisioner.getStatus('pairing-1', 'partner', 'stale-catalog')).rejects.toThrow(
      'Reload or update the app',
    );
    expect(matchMaker.createRoom).not.toHaveBeenCalled();
    expect(matchMaker.reserveSeatFor).not.toHaveBeenCalled();
  });
});
