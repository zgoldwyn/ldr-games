import { elementalCatalogFingerprint } from '@ldr/core';

export const PLATFORMER_ROOM_NAME = 'elemental_platformer';
export const PLATFORMER_CATALOG_FINGERPRINT = elementalCatalogFingerprint();
export const PLATFORMER_CATALOG_MISMATCH_MESSAGE =
  'Your Ember & Tide levels are out of date. Reload or update the app before starting or joining a game.';
export const PLATFORMER_TICK_RATE = 30;
export const PLATFORMER_PHYSICS_SUBSTEPS = 2;
// Match state delivery to the simulation cadence. The previous 50 ms patches
// made remote motion arrive at only 20 Hz and forced the client to buffer more
// history than a two-player LAN platformer needs.
export const PLATFORMER_PATCH_RATE_MS = 33;
export const PLATFORMER_MAX_CLIENTS = 2;
