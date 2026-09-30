import express from 'express';
import { defineRoom, defineServer, matchMaker } from 'colyseus';

import { readGameServerConfig } from './config.js';
import {
  PLATFORMER_CATALOG_FINGERPRINT,
  PLATFORMER_CATALOG_MISMATCH_MESSAGE,
  PLATFORMER_ROOM_NAME,
} from './platformer/constants.js';
import { PlatformerRoom } from './platformer/PlatformerRoom.js';
import {
  DevSessionProvisioner,
  type DevSessionRequest,
  type MatchMakerPort,
} from './platformer/provisioning.js';

const config = readGameServerConfig();
const matchMakerPort: MatchMakerPort = {
  createRoom: async (roomName, options) => matchMaker.createRoom(roomName, options),
  getRoomActivity: async (roomId) => {
    try {
      const room = await matchMaker.getRoomById(roomId);
      return { exists: true, clients: room.clients };
    } catch {
      return { exists: false, clients: 0 };
    }
  },
  reserveSeatFor: async (room, clientOptions, authData) => {
    // A later seat claim only carries the room id. Resolve the complete cache
    // record so Colyseus can include name/processId in the client reservation.
    const liveRoom = await matchMaker.getRoomById(room.roomId);
    return matchMaker.reserveSeatFor(liveRoom, clientOptions, authData);
  },
};
const devProvisioner = new DevSessionProvisioner(matchMakerPort);

function isDevSessionRequest(value: unknown): value is DevSessionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.gameSessionId === 'string' &&
    typeof request.pairingId === 'string' &&
    typeof request.creatorAccountId === 'string' &&
    typeof request.linkedAccountId === 'string' &&
    (request.creatorRole === 'ember' || request.creatorRole === 'tide')
  );
}

function isDevSeatClaim(
  value: unknown,
): value is { pairingId: string; accountId: string; catalogFingerprint: string } {
  if (!value || typeof value !== 'object') return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.pairingId === 'string' && typeof claim.accountId === 'string';
}

function rejectStalePlatformerClient(
  catalogFingerprint: string | undefined,
  response: express.Response,
): boolean {
  if (catalogFingerprint === PLATFORMER_CATALOG_FINGERPRINT) return false;
  response.status(409).json({
    error: PLATFORMER_CATALOG_MISMATCH_MESSAGE,
    catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
  });
  return true;
}

function platformerErrorStatus(error: unknown, fallback: number): number {
  return error instanceof Error && error.message === PLATFORMER_CATALOG_MISMATCH_MESSAGE
    ? 409
    : fallback;
}

export const server = defineServer({
  rooms: {
    [PLATFORMER_ROOM_NAME]: defineRoom(PlatformerRoom),
  },
  express: (app) => {
    app.use(express.json({ limit: '16kb' }));
    app.get('/health', (_request, response) => {
      response.json({
        ok: true,
        service: '@ldr/game-server',
        platformerCatalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
      });
    });

    if (config.devAdmissionEnabled) {
      app.post('/dev/platformer-sessions', async (request, response) => {
        if (request.header('x-dev-admission-key') !== config.devAdmissionKey) {
          response.status(401).json({ error: 'invalid dev admission key' });
          return;
        }
        if (!isDevSessionRequest(request.body)) {
          response.status(400).json({ error: 'invalid platformer session request' });
          return;
        }
        if (rejectStalePlatformerClient(request.body.catalogFingerprint, response)) return;

        try {
          const session = await devProvisioner.provision(request.body);
          response.status(201).json({
            roomId: session.roomId,
            gameSessionId: request.body.gameSessionId,
            role: request.body.creatorRole,
            reservation: session.creatorReservation,
            catalogFingerprint: PLATFORMER_CATALOG_FINGERPRINT,
            savedLevel: session.savedLevel,
          });
        } catch (error) {
          response.status(platformerErrorStatus(error, 400)).json({
            error: error instanceof Error ? error.message : 'unable to provision session',
          });
        }
      });

      app.post('/dev/platformer-sessions/claim', async (request, response) => {
        if (request.header('x-dev-admission-key') !== config.devAdmissionKey) {
          response.status(401).json({ error: 'invalid dev admission key' });
          return;
        }
        if (!isDevSeatClaim(request.body)) {
          response.status(400).json({ error: 'invalid platformer seat claim' });
          return;
        }
        if (rejectStalePlatformerClient(request.body.catalogFingerprint, response)) return;

        try {
          response
            .status(200)
            .json(
              await devProvisioner.claimSeat(
                request.body.pairingId,
                request.body.accountId,
                request.body.catalogFingerprint,
              ),
            );
        } catch (error) {
          response.status(platformerErrorStatus(error, 404)).json({
            error: error instanceof Error ? error.message : 'unable to claim linked seat',
          });
        }
      });

      app.post('/dev/platformer-sessions/status', async (request, response) => {
        if (request.header('x-dev-admission-key') !== config.devAdmissionKey) {
          response.status(401).json({ error: 'invalid dev admission key' });
          return;
        }
        if (!isDevSeatClaim(request.body)) {
          response.status(400).json({ error: 'invalid platformer status request' });
          return;
        }
        if (rejectStalePlatformerClient(request.body.catalogFingerprint, response)) return;
        try {
          response
            .status(200)
            .json(
              await devProvisioner.getStatus(
                request.body.pairingId,
                request.body.accountId,
                request.body.catalogFingerprint,
              ),
            );
        } catch (error) {
          response.status(platformerErrorStatus(error, 400)).json({
            error: error instanceof Error ? error.message : 'unable to read platformer status',
          });
        }
      });
    }
  },
});

export default server;
