import { Client, type Room, type SeatReservation } from '@colyseus/sdk';
import { elementalCatalogFingerprint, type ElementalRole } from '@ldr/core';

import type { GameServerDevConfig } from '../config';

export interface PlatformerSessionAccess {
  readonly roomId: string;
  readonly gameSessionId: string;
  readonly role: ElementalRole;
  readonly reservation: SeatReservation;
  readonly catalogFingerprint: string;
  readonly savedLevel?: number;
}

export interface CreatePlatformerSessionRequest {
  readonly gameSessionId: string;
  readonly pairingId: string;
  readonly creatorAccountId: string;
  readonly linkedAccountId: string;
  readonly creatorRole: ElementalRole;
}

export interface PlatformerSessionStatus {
  readonly active: boolean;
  readonly catalogFingerprint: string;
  readonly role?: ElementalRole;
  readonly createdByYou?: boolean;
  readonly savedLevel: number;
}

const LOCAL_CATALOG_FINGERPRINT = elementalCatalogFingerprint();
const CATALOG_MISMATCH_MESSAGE =
  'Your Ember & Tide levels are out of date. Reload or update the app before starting or joining a game.';

function assertMatchingCatalog(payload: { readonly catalogFingerprint?: string }): void {
  if (payload.catalogFingerprint !== LOCAL_CATALOG_FINGERPRINT) {
    throw new Error(CATALOG_MISMATCH_MESSAGE);
  }
}

export function isExpiredSeatReservationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /seat reservation expired|\b4002\b/i.test(message);
}

export function isWaitingForPlatformerSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === 'No local platformer session is waiting';
}

async function postJson(
  config: GameServerDevConfig,
  path: string,
  body: object,
  timeoutMs = 3_000,
): Promise<PlatformerSessionAccess> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-admission-key': config.admissionKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json()) as PlatformerSessionAccess | { error?: string };
    if (!response.ok) {
      throw new Error(
        'error' in payload && payload.error ? payload.error : 'Game server request failed',
      );
    }
    const access = payload as PlatformerSessionAccess;
    assertMatchingCatalog(access);
    return access;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out connecting to the local game server');
    }
    if (error instanceof TypeError) {
      throw new Error(`Cannot reach the game server at ${config.url}. Start the server and retry.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function postStatus(
  config: GameServerDevConfig,
  path: string,
  body: object,
): Promise<PlatformerSessionStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-admission-key': config.admissionKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json()) as PlatformerSessionStatus | { error?: string };
    if (!response.ok) {
      throw new Error(
        'error' in payload && payload.error ? payload.error : 'Unable to check the current game',
      );
    }
    const status = payload as PlatformerSessionStatus;
    assertMatchingCatalog(status);
    return status;
  } finally {
    clearTimeout(timeout);
  }
}

export function createDevPlatformerSession(
  config: GameServerDevConfig,
  request: CreatePlatformerSessionRequest,
): Promise<PlatformerSessionAccess> {
  return postJson(config, '/dev/platformer-sessions', {
    ...request,
    catalogFingerprint: LOCAL_CATALOG_FINGERPRINT,
  });
}

export function claimDevPlatformerSeat(
  config: GameServerDevConfig,
  pairingId: string,
  accountId: string,
): Promise<PlatformerSessionAccess> {
  return postJson(config, '/dev/platformer-sessions/claim', {
    pairingId,
    accountId,
    catalogFingerprint: LOCAL_CATALOG_FINGERPRINT,
  });
}

export function getDevPlatformerSessionStatus(
  config: GameServerDevConfig,
  pairingId: string,
  accountId: string,
): Promise<PlatformerSessionStatus> {
  return postStatus(config, '/dev/platformer-sessions/status', {
    pairingId,
    accountId,
    catalogFingerprint: LOCAL_CATALOG_FINGERPRINT,
  });
}

export async function connectToPlatformerRoom(
  config: GameServerDevConfig,
  access: PlatformerSessionAccess,
  timeoutMs = 5_000,
): Promise<Room> {
  assertMatchingCatalog(access);
  const client = new Client(config.url);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.consumeSeatReservation(access.reservation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out connecting to the game room')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
