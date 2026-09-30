import { describe, expect, it } from 'vitest';

import { ELEMENTAL_DUNGEON_LEVEL } from '@ldr/core';

import {
  ONLINE_LOCAL_CORRECTION_SMOOTH_MS,
  ONLINE_PLATFORMER_PATCH_INTERVAL_MS,
  ONLINE_REMOTE_INTERPOLATION_DELAY_MS,
  ELEMENTAL_CRYSTAL_BASE_SIZE,
  elementalCrystalScreenPosition,
  landPredictedPlayerOnFloor,
  respawnPredictedPlayer,
} from './elemental-online-prediction';

describe('online platformer prediction', () => {
  it('renders a center-authored crystal around its exported coordinate', () => {
    const rendered = elementalCrystalScreenPosition({
      x: 39,
      y: 9.5,
      horizontalScale: 4,
      verticalScale: 5,
      stageScale: 2,
      floorY: 300,
    });
    const renderedSize = ELEMENTAL_CRYSTAL_BASE_SIZE * 2;
    expect(rendered.left + renderedSize / 2).toBe(39 * 4);
    expect(rendered.top + renderedSize / 2).toBe(300 - 9.5 * 5);
  });

  it('keeps LAN smoothing responsive while buffering two authoritative patches', () => {
    expect(ONLINE_PLATFORMER_PATCH_INTERVAL_MS).toBe(33);
    expect(ONLINE_REMOTE_INTERPOLATION_DELAY_MS).toBe(
      ONLINE_PLATFORMER_PATCH_INTERVAL_MS * 2,
    );
    expect(ONLINE_LOCAL_CORRECTION_SMOOTH_MS).toBeLessThan(
      ONLINE_PLATFORMER_PATCH_INTERVAL_MS,
    );
  });

  it('lands on the underground floor without teleporting to the elevated spawn', () => {
    const player = {
      x: 30,
      y: -0.05,
      velocityX: 2,
      velocityY: -3,
      grounded: false,
    };

    landPredictedPlayerOnFloor(player);

    expect(player.y).toBe(0);
    expect(player.velocityY).toBe(0);
    expect(player.grounded).toBe(true);
    expect(player.x).toBe(30);
  });

  it('uses the elevated authored spawn only after death', () => {
    const player = {
      x: 30,
      y: 0,
      velocityX: 2,
      velocityY: -3,
      grounded: true,
    };

    respawnPredictedPlayer(player, 'ember', ELEMENTAL_DUNGEON_LEVEL);

    expect(player.x).toBe(ELEMENTAL_DUNGEON_LEVEL.spawns.ember);
    expect(player.y).toBe(ELEMENTAL_DUNGEON_LEVEL.spawnY.ember);
    expect(player.velocityX).toBe(0);
    expect(player.velocityY).toBe(0);
  });
});
