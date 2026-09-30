import type { ElementalLevel, ElementalRole } from '@ldr/core';

/** Networking/render tuning for the 30 Hz authoritative platformer. */
export const ONLINE_PLATFORMER_INPUT_RATE = 30;
export const ONLINE_PLATFORMER_PATCH_INTERVAL_MS = 33;
// Two patch intervals absorb normal Wi-Fi jitter without the old 100 ms drag.
export const ONLINE_REMOTE_INTERPOLATION_DELAY_MS = 66;
// Corrections should be invisible but short enough that controls stay crisp.
export const ONLINE_LOCAL_CORRECTION_SMOOTH_MS = 24;
export const ELEMENTAL_CRYSTAL_BASE_SIZE = 12;

/** Convert a center-authored crystal coordinate into its top-left render position. */
export function elementalCrystalScreenPosition({
  x,
  y,
  horizontalScale,
  verticalScale,
  stageScale,
  floorY,
}: {
  readonly x: number;
  readonly y: number;
  readonly horizontalScale: number;
  readonly verticalScale: number;
  readonly stageScale: number;
  readonly floorY: number;
}): { readonly left: number; readonly top: number } {
  const size = ELEMENTAL_CRYSTAL_BASE_SIZE * stageScale;
  return {
    left: x * horizontalScale - size / 2,
    top: floorY - y * verticalScale - size / 2,
  };
}

export interface PredictedPlatformerPlayer {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  grounded: boolean;
}

/** Floor contact is a landing, never a respawn. */
export function landPredictedPlayerOnFloor(player: PredictedPlatformerPlayer): void {
  player.y = 0;
  player.velocityY = 0;
  player.grounded = true;
}

/** Death returns a player to the authored spawn, including elevated starts. */
export function respawnPredictedPlayer(
  player: PredictedPlatformerPlayer,
  role: ElementalRole,
  level: ElementalLevel,
): void {
  player.x = level.spawns[role];
  player.y = level.spawnY[role];
  player.velocityX = 0;
  player.velocityY = 0;
  player.grounded = true;
}
