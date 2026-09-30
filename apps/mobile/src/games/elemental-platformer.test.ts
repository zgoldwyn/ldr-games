import { describe, expect, it } from 'vitest';

import {
  ELEMENTAL_FLOOR_Y,
  ELEMENTAL_GATES,
  ELEMENTAL_PLATFORM,
  ELEMENTAL_PLAYER_SIZE,
  ELEMENTAL_VIEWPORT_WIDTH,
  ELEMENTAL_WORLD_WIDTH,
  elementalCameraOffset,
  elementalSpectatorZoom,
  elementalStageScale,
  elementalVerticalCameraOffset,
  isElementalPlayerAtGate,
  stepElementalPlayer,
} from './elemental-platformer';

describe('elemental platformer movement', () => {
  const grounded = {
    x: 100,
    y: ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE,
    vx: 0,
    vy: 0,
    grounded: true,
  } as const;

  it('accelerates toward directional input', () => {
    const next = stepElementalPlayer(grounded, { horizontal: 1, jumpPressed: false }, 1 / 60);
    expect(next.x).toBeGreaterThan(grounded.x);
    expect(next.vx).toBeGreaterThan(0);
  });

  it('jumps only while grounded', () => {
    const jumping = stepElementalPlayer(grounded, { horizontal: 0, jumpPressed: true }, 1 / 60);
    expect(jumping.y).toBeLessThan(grounded.y);
    expect(jumping.vy).toBeLessThan(0);

    const airborne = stepElementalPlayer(jumping, { horizontal: 0, jumpPressed: true }, 1 / 60);
    expect(airborne.vy).toBeGreaterThan(jumping.vy);
  });

  it('keeps the player inside the level bounds', () => {
    const atEdge = { ...grounded, x: ELEMENTAL_WORLD_WIDTH - ELEMENTAL_PLAYER_SIZE, vx: 100 };
    const next = stepElementalPlayer(atEdge, { horizontal: 1, jumpPressed: false }, 1 / 30);
    expect(next.x).toBe(ELEMENTAL_WORLD_WIDTH - ELEMENTAL_PLAYER_SIZE);
  });

  it('lets a normal jump land on the tutorial platform', () => {
    let player = { ...grounded, x: ELEMENTAL_PLATFORM.x + 12 };
    let landed = false;

    for (let frame = 0; frame < 120; frame += 1) {
      player = stepElementalPlayer(player, { horizontal: 0, jumpPressed: frame === 0 }, 1 / 60);
      if (player.grounded && player.y === ELEMENTAL_PLATFORM.y - ELEMENTAL_PLAYER_SIZE) {
        landed = true;
        break;
      }
    }

    expect(landed).toBe(true);
  });

  it('requires two-dimensional overlap with the matching gate', () => {
    const insideEmberGate = {
      x: ELEMENTAL_GATES.ember.x,
      y: ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE,
    };

    expect(isElementalPlayerAtGate('ember', insideEmberGate)).toBe(true);
    expect(isElementalPlayerAtGate('tide', insideEmberGate)).toBe(false);
    expect(isElementalPlayerAtGate('ember', { ...insideEmberGate, y: 70 })).toBe(false);
  });

  it.each([280, 320, 360])('uses one uniform stage scale at %ipx', (width) => {
    const scale = elementalStageScale(width);
    expect(ELEMENTAL_VIEWPORT_WIDTH * scale).toBe(width);
    expect(ELEMENTAL_WORLD_WIDTH * scale).toBeGreaterThan(width * 2);
    expect(ELEMENTAL_PLATFORM.x * scale).toBeCloseTo(
      (ELEMENTAL_PLATFORM.x / ELEMENTAL_VIEWPORT_WIDTH) * width,
    );
    expect(ELEMENTAL_GATES.tide.y * scale).toBeCloseTo(
      (ELEMENTAL_GATES.tide.y / ELEMENTAL_VIEWPORT_WIDTH) * width,
    );
  });

  it('clamps the follow camera at both world edges', () => {
    const viewport = 320;
    const world = 760;
    expect(elementalCameraOffset(0, 1, viewport, world)).toBe(0);
    expect(elementalCameraOffset(380, 1, viewport, world)).toBeGreaterThan(0);
    expect(elementalCameraOffset(760, 1, viewport, world)).toBe(world - viewport);
  });

  it('keeps the player visible while clamping vertical travel to the world edges', () => {
    const viewportHeight = 300;
    const worldHeight = 500;
    expect(elementalVerticalCameraOffset(420, viewportHeight, worldHeight)).toBe(-200);
    expect(elementalVerticalCameraOffset(220, viewportHeight, worldHeight)).toBe(-64);
    expect(elementalVerticalCameraOffset(100, viewportHeight, worldHeight)).toBe(0);
    expect(elementalVerticalCameraOffset(100, 600, worldHeight)).toBe(50);
  });

  it('fits the whole level in spectator mode at every phone width', () => {
    for (const viewport of [280, 320, 360]) {
      const scale = elementalStageScale(viewport);
      const world = ELEMENTAL_WORLD_WIDTH * scale;
      expect(world * elementalSpectatorZoom(viewport, world)).toBeCloseTo(viewport);
    }
  });
});
