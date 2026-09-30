import { randomUUID } from 'node:crypto';

import {
  accountId,
  assignElementalRoles,
  type ElementalRole,
  type ElementalRoleAssignment,
} from '@ldr/core';

import {
  PLATFORMER_CATALOG_FINGERPRINT,
  PLATFORMER_CATALOG_MISMATCH_MESSAGE,
  PLATFORMER_ROOM_NAME,
} from './constants.js';
import type { PlatformerAdmission, PlatformerRoomOptions } from './admission.js';
import { loadPairingProgress } from './progress.js';

export const PROCESS_PROVISIONING_NONCE = randomUUID();

export interface DevSessionRequest {
  readonly gameSessionId: string;
  readonly pairingId: string;
  readonly creatorAccountId: string;
  readonly linkedAccountId: string;
  readonly creatorRole: ElementalRole;
  readonly catalogFingerprint: string;
}

export interface SeatReservation {
  readonly roomId: string;
  readonly sessionId: string;
}

export interface ProvisionedDevSession {
  readonly roomId: string;
  readonly assignment: ElementalRoleAssignment;
  readonly creatorAccountId: string;
  readonly createdAt: number;
  readonly creatorReservation: SeatReservation;
  readonly savedLevel: number;
}

export interface DevSessionStatus {
  readonly active: boolean;
  readonly catalogFingerprint: string;
  readonly role?: ElementalRole;
  readonly createdByYou?: boolean;
  readonly savedLevel: number;
}

export interface DevSeatClaim {
  readonly roomId: string;
  readonly gameSessionId: string;
  readonly role: ElementalRole;
  readonly reservation: SeatReservation;
  readonly catalogFingerprint: string;
}

export interface MatchMakerPort {
  createRoom(roomName: string, options: PlatformerRoomOptions): Promise<{ roomId: string }>;
  getRoomActivity(roomId: string): Promise<{ exists: boolean; clients: number }>;
  reserveSeatFor(
    room: { roomId: string },
    clientOptions: Record<string, never>,
    authData: PlatformerAdmission,
  ): Promise<SeatReservation>;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(`${label} must contain between 1 and 200 characters`);
  }
  return normalized;
}

function assertCurrentCatalog(fingerprint: string): void {
  if (fingerprint !== PLATFORMER_CATALOG_FINGERPRINT) {
    throw new Error(PLATFORMER_CATALOG_MISMATCH_MESSAGE);
  }
}

export function validateDevSessionRequest(request: DevSessionRequest): DevSessionRequest {
  const validated = {
    gameSessionId: requireIdentifier(request.gameSessionId, 'gameSessionId'),
    pairingId: requireIdentifier(request.pairingId, 'pairingId'),
    creatorAccountId: requireIdentifier(request.creatorAccountId, 'creatorAccountId'),
    linkedAccountId: requireIdentifier(request.linkedAccountId, 'linkedAccountId'),
    creatorRole: request.creatorRole,
    catalogFingerprint: requireIdentifier(request.catalogFingerprint, 'catalogFingerprint'),
  };
  if (validated.creatorRole !== 'ember' && validated.creatorRole !== 'tide') {
    throw new Error('creatorRole must be ember or tide');
  }
  if (validated.creatorAccountId === validated.linkedAccountId) {
    throw new Error('creatorAccountId and linkedAccountId must be different');
  }
  assertCurrentCatalog(validated.catalogFingerprint);
  return validated;
}

/** Process-local prototype mapping. Supabase will replace this map durably. */
export class DevSessionProvisioner {
  private readonly sessions = new Map<string, Promise<ProvisionedDevSession>>();
  private readonly sessionIdByPairing = new Map<string, string>();

  constructor(private readonly matchMaker: MatchMakerPort) {}

  async getStatus(
    pairingId: string,
    accountId: string,
    catalogFingerprint: string,
  ): Promise<DevSessionStatus> {
    assertCurrentCatalog(catalogFingerprint);
    const normalizedPairingId = requireIdentifier(pairingId, 'pairingId');
    const normalizedAccountId = requireIdentifier(accountId, 'accountId');
    const gameSessionId = this.sessionIdByPairing.get(normalizedPairingId);
    const pending = gameSessionId ? this.sessions.get(gameSessionId) : undefined;
    if (!gameSessionId || !pending) {
      return {
        active: false,
        catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
        savedLevel: await loadPairingProgress(normalizedPairingId),
      };
    }

    const session = await pending;
    const activity = await this.matchMaker.getRoomActivity(session.roomId);
    const abandonedBeforeJoin = activity.clients === 0 && Date.now() - session.createdAt > 20_000;
    if (!activity.exists || abandonedBeforeJoin) {
      this.sessions.delete(gameSessionId);
      this.sessionIdByPairing.delete(normalizedPairingId);
      return {
        active: false,
        catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
        savedLevel: await loadPairingProgress(normalizedPairingId),
      };
    }
    const role =
      session.assignment.ember === normalizedAccountId
        ? 'ember'
        : session.assignment.tide === normalizedAccountId
          ? 'tide'
          : undefined;
    return role
      ? {
          active: true,
          catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
          role,
          createdByYou: session.creatorAccountId === normalizedAccountId,
          savedLevel: session.savedLevel,
        }
      : {
          active: false,
          catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
          savedLevel: await loadPairingProgress(normalizedPairingId),
        };
  }

  provision(rawRequest: DevSessionRequest): Promise<ProvisionedDevSession> {
    const request = validateDevSessionRequest(rawRequest);
    const pairingSessionId = this.sessionIdByPairing.get(request.pairingId);
    if (pairingSessionId && pairingSessionId !== request.gameSessionId) {
      throw new Error('This pairing already has an active local platformer session');
    }
    const existing = this.sessions.get(request.gameSessionId);
    if (existing) return existing;

    const pending = this.create(request);
    this.sessions.set(request.gameSessionId, pending);
    this.sessionIdByPairing.set(request.pairingId, request.gameSessionId);
    pending.catch(() => {
      this.sessions.delete(request.gameSessionId);
      this.sessionIdByPairing.delete(request.pairingId);
    });
    return pending;
  }

  async claimSeat(
    pairingId: string,
    accountId: string,
    catalogFingerprint: string,
  ): Promise<DevSeatClaim> {
    assertCurrentCatalog(catalogFingerprint);
    const normalizedPairingId = requireIdentifier(pairingId, 'pairingId');
    const normalizedAccountId = requireIdentifier(accountId, 'accountId');
    const gameSessionId = this.sessionIdByPairing.get(normalizedPairingId);
    const pending = gameSessionId ? this.sessions.get(gameSessionId) : undefined;
    if (!gameSessionId || !pending) throw new Error('No local platformer session is waiting');

    const session = await pending;
    const role =
      session.assignment.ember === normalizedAccountId
        ? 'ember'
        : session.assignment.tide === normalizedAccountId
          ? 'tide'
          : null;
    if (!role) throw new Error('This account is not assigned to the waiting session');
    const reservation = await this.matchMaker.reserveSeatFor(
      { roomId: session.roomId },
      {},
      {
        userId: normalizedAccountId,
        gameSessionId,
        pairingId: normalizedPairingId,
        role,
        catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
        source: 'dev-seat-reservation',
      },
    );
    return {
      roomId: session.roomId,
      gameSessionId,
      role,
      reservation,
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
    };
  }

  private async create(request: DevSessionRequest): Promise<ProvisionedDevSession> {
    const savedLevel = await loadPairingProgress(request.pairingId);
    const assignment = assignElementalRoles(
      accountId(request.creatorAccountId),
      accountId(request.linkedAccountId),
      request.creatorRole,
    );
    const roomOptions: PlatformerRoomOptions = {
      provisioningNonce: PROCESS_PROVISIONING_NONCE,
      gameSessionId: request.gameSessionId,
      pairingId: request.pairingId,
      assignment,
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
      startLevel: savedLevel,
    };
    const room = await this.matchMaker.createRoom(PLATFORMER_ROOM_NAME, roomOptions);

    const admission = (userId: string, role: ElementalRole): PlatformerAdmission => ({
      userId,
      gameSessionId: request.gameSessionId,
      pairingId: request.pairingId,
      role,
      catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
      source: 'dev-seat-reservation',
    });
    // Only reserve the creator here. The partner claims the second seat when
    // they actually tap Join; pre-reserving both made that claim a third seat.
    const creatorReservation = await this.matchMaker.reserveSeatFor(
      room,
      {},
      admission(request.creatorAccountId, request.creatorRole),
    );

    return {
      roomId: room.roomId,
      assignment,
      creatorAccountId: request.creatorAccountId,
      createdAt: Date.now(),
      creatorReservation,
      savedLevel,
    };
  }
}
