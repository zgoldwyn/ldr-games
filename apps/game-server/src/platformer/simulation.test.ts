import { describe, expect, it } from 'vitest';
import {
  ELEMENTAL_ALL_CRYSTALS_MASK,
  ELEMENTAL_FOUNDRY_LEVEL,
  ELEMENTAL_GROVE_LEVEL,
  ELEMENTAL_DUNGEON_LEVEL,
  elementalCrystalMaskForRole,
} from '@ldr/core';

import { PlatformerInput } from './input.js';
import {
  collectPlatformerCrystals,
  evaluatePlatformerGates,
  nextPlatformerLeverActivated,
  nextPlatformerElapsedTicks,
  platformerCrateSupportY,
  PLATFORMER_WORLD,
  resetPlatformerCrystalsForRole,
  resolvePlatformerCrateX,
  stepPlatformerCrate,
  stepPlatformerPlayer,
  type MutablePlayerKinematics,
} from './simulation.js';

const STEP = { dt: 1 / 30, subSteps: 2, subDt: 1 / 60 } as const;

function player(): MutablePlayerKinematics {
  return { x: 3, y: 0, velocityX: 0, velocityY: 0, grounded: true };
}

function input(overrides: Partial<PlatformerInput> = {}): PlatformerInput {
  return new PlatformerInput({ moveX: 0, jump: false, interact: false, ...overrides });
}

describe('authoritative platformer simulation', () => {
  it('toggles a lever off as well as on and does not retrigger while held', () => {
    expect(nextPlatformerLeverActivated(false, true, false, true)).toBe(true);
    expect(nextPlatformerLeverActivated(true, true, true, true)).toBe(true);
    expect(nextPlatformerLeverActivated(true, false, true, true)).toBe(true);
    expect(nextPlatformerLeverActivated(true, true, false, true)).toBe(false);
    expect(nextPlatformerLeverActivated(true, true, false, false)).toBe(true);
  });

  it('counts active ticks and pauses or freezes the shared clock', () => {
    expect(nextPlatformerElapsedTicks(0, false, false)).toBe(0);
    expect(nextPlatformerElapsedTicks(0, true, false)).toBe(1);
    expect(nextPlatformerElapsedTicks(1, false, false)).toBe(1);
    expect(nextPlatformerElapsedTicks(1, true, true)).toBe(1);
  });
  it('is deterministic for the same initial state and input sequence', () => {
    const first = player();
    const second = player();
    const sequence = [input({ moveX: 1 }), input({ moveX: 1, jump: true }), input({ moveX: -1 })];

    for (const command of sequence) {
      stepPlatformerPlayer(first, command, STEP);
      stepPlatformerPlayer(second, command, STEP);
    }

    expect(first).toEqual(second);
  });

  it('applies one jump impulse while integrating two physics substeps', () => {
    const state = player();
    stepPlatformerPlayer(state, input({ jump: true }), STEP);

    expect(state.grounded).toBe(false);
    expect(state.velocityY).toBeCloseTo(12.2, 8);
    expect(state.y).toBeCloseTo(0.413_333_333_3, 8);
  });

  it('keeps players inside the authoritative world bounds', () => {
    const state = player();
    state.x = PLATFORMER_WORLD.maxX - 0.01;
    for (let tick = 0; tick < 10; tick += 1) {
      stepPlatformerPlayer(state, input({ moveX: 1 }), STEP);
    }
    expect(state.x).toBe(PLATFORMER_WORLD.maxX);
  });

  it('requires both grounded players in their matching gates to complete the level', () => {
    const ember = { ...player(), x: 1 };
    const tide = { ...player(), x: PLATFORMER_WORLD.maxX };

    expect(evaluatePlatformerGates(ember, { ...tide, x: 10 }, { ember: true, tide: true })).toEqual(
      {
        emberAtGate: true,
        tideAtGate: false,
        completed: false,
      },
    );
    expect(evaluatePlatformerGates(ember, tide, { ember: true, tide: true })).toEqual({
      emberAtGate: true,
      tideAtGate: true,
      completed: true,
    });
    expect(
      evaluatePlatformerGates({ ...ember, y: 1, grounded: false }, tide, {
        ember: true,
        tide: true,
      }).completed,
    ).toBe(false);
    expect(evaluatePlatformerGates(ember, tide, { ember: false, tide: false })).toEqual({
      emberAtGate: false,
      tideAtGate: false,
      completed: false,
    });
    expect(evaluatePlatformerGates(ember, tide, { ember: true, tide: false })).toEqual({
      emberAtGate: true,
      tideAtGate: false,
      completed: false,
    });
  });

  it('recognizes both authored dungeon gates only at their floor elevation', () => {
    const emberGate = ELEMENTAL_DUNGEON_LEVEL.gates.ember;
    const tideGate = ELEMENTAL_DUNGEON_LEVEL.gates.tide;
    const ember = { ...player(), x: emberGate.x, y: emberGate.y };
    const tide = { ...player(), x: tideGate.x, y: tideGate.y };

    expect(
      evaluatePlatformerGates(ember, tide, { ember: true, tide: true }, ELEMENTAL_DUNGEON_LEVEL),
    ).toEqual({ emberAtGate: true, tideAtGate: true, completed: true });
    expect(
      evaluatePlatformerGates(
        { ...ember, y: 1 },
        tide,
        { ember: true, tide: true },
        ELEMENTAL_DUNGEON_LEVEL,
      ).emberAtGate,
    ).toBe(false);
  });

  it('lands on the authored grove platforms', () => {
    const platform = ELEMENTAL_GROVE_LEVEL.platforms.reduce((lowest, candidate) =>
      candidate.y < lowest.y ? candidate : lowest,
    );
    const state = { ...player(), x: platform.x + 1 };
    stepPlatformerPlayer(state, input({ jump: true }), STEP);
    for (let tick = 0; tick < 90 && !state.grounded; tick += 1) {
      stepPlatformerPlayer(state, input(), STEP);
    }
    expect(state.grounded).toBe(true);
    expect(state.y).toBe(platform.y);
  });

  it('lets only the matching spirit land on an elemental platform', () => {
    const platform = ELEMENTAL_GROVE_LEVEL.platforms
      .filter((candidate) => candidate.element === 'ember')
      .reduce((lowest, candidate) => (candidate.y < lowest.y ? candidate : lowest));
    expect(platform).toBeDefined();
    const ember = { ...player(), x: platform!.x + 1 };
    const tide = { ...player(), x: platform!.x + 1 };

    stepPlatformerPlayer(ember, input({ jump: true }), STEP, 'ember');
    stepPlatformerPlayer(tide, input({ jump: true }), STEP, 'tide');
    for (let tick = 0; tick < 90 && (!ember.grounded || !tide.grounded); tick += 1) {
      stepPlatformerPlayer(ember, input(), STEP, 'ember');
      stepPlatformerPlayer(tide, input(), STEP, 'tide');
    }

    expect(ember.y).toBe(platform!.y);
    expect(tide.y).toBe(0);
  });

  it('collects only role-matched crystals and never clears collected bits', () => {
    const emberIndex = ELEMENTAL_GROVE_LEVEL.crystals.findIndex(
      (crystal) => crystal.role === 'ember',
    );
    const tideIndex = ELEMENTAL_GROVE_LEVEL.crystals.findIndex(
      (crystal) => crystal.role === 'tide',
    );
    const emberCrystal = ELEMENTAL_GROVE_LEVEL.crystals[emberIndex]!;
    const tideCrystal = ELEMENTAL_GROVE_LEVEL.crystals[tideIndex]!;
    const ember = { ...player(), x: emberCrystal.x - 0.8, y: emberCrystal.y - 1 };
    const tide = { ...player(), x: tideCrystal.x - 0.8, y: tideCrystal.y - 1 };

    const bothCollected = collectPlatformerCrystals(ember, tide, 0);
    expect(bothCollected).toBe((1 << emberIndex) | (1 << tideIndex));
    expect(collectPlatformerCrystals(undefined, undefined, bothCollected)).toBe(bothCollected);
  });

  it('clears only the dead spirit shards', () => {
    const emberMask = elementalCrystalMaskForRole('ember');
    const tideMask = elementalCrystalMaskForRole('tide');
    expect(resetPlatformerCrystalsForRole(ELEMENTAL_ALL_CRYSTALS_MASK, 'ember')).toBe(tideMask);
    expect(resetPlatformerCrystalsForRole(ELEMENTAL_ALL_CRYSTALS_MASK, 'tide')).toBe(emberMask);
  });

  it('kills both roles in a level-two void pool', () => {
    const hazard = ELEMENTAL_FOUNDRY_LEVEL.hazards.find(
      (candidate) => candidate.safeRole === 'none',
    )!;
    for (const role of ['ember', 'tide'] as const) {
      const state = { ...player(), x: hazard.x };
      expect(stepPlatformerPlayer(state, input(), STEP, role, ELEMENTAL_FOUNDRY_LEVEL)).toBe(true);
      expect(state.x).toBe(ELEMENTAL_FOUNDRY_LEVEL.spawns[role]);
    }
  });

  it('turns the lever bridge into a safe, landable crossing', () => {
    const bridgeHazard = ELEMENTAL_FOUNDRY_LEVEL.hazards.find(
      (hazard) => hazard.id === ELEMENTAL_FOUNDRY_LEVEL.mechanics.activatedPlatform.hazardId,
    )!;
    const state = {
      ...player(),
      x: bridgeHazard.x,
      y: 0.05,
      velocityY: -2,
      grounded: false,
    };
    expect(
      stepPlatformerPlayer(
        state,
        input(),
        STEP,
        'ember',
        ELEMENTAL_FOUNDRY_LEVEL,
        bridgeHazard.id,
        undefined,
        true,
      ),
    ).toBe(false);
    expect(state.x).toBe(bridgeHazard.x);
    expect(state.y).toBe(0);
    expect(state.grounded).toBe(true);
  });

  it('moves the weight once from the contacted side and keeps it inside world geometry', () => {
    const crate = ELEMENTAL_FOUNDRY_LEVEL.mechanics.pushable;
    const pusher = { ...player(), x: crate.x + crate.width };
    const nextX = stepPlatformerCrate(
      crate.x,
      [{ player: pusher, input: input({ moveX: -1 }) }],
      STEP.dt,
      ELEMENTAL_FOUNDRY_LEVEL,
    );
    expect(nextX).toBeCloseTo(crate.x - crate.pushSpeed * STEP.dt);
    expect(pusher.x).toBeGreaterThanOrEqual(nextX + crate.width);

    const emptyTrack = { ...ELEMENTAL_FOUNDRY_LEVEL, solids: [], platforms: [], ramps: [] };
    expect(resolvePlatformerCrateX(crate.x, -20, emptyTrack)).toBe(0);
    expect(resolvePlatformerCrateX(crate.x, 100, emptyTrack)).toBe(emptyTrack.width - crate.width);
  });

  it('stops a pushable at solid walls and vertical platform sides', () => {
    const crate = ELEMENTAL_FOUNDRY_LEVEL.mechanics.pushable;
    const withWall = {
      ...ELEMENTAL_FOUNDRY_LEVEL,
      solids: [{ id: 'crate-stop', x: 30, y: 0, width: 2, height: 4 }],
    };
    expect(resolvePlatformerCrateX(crate.x, 31, withWall)).toBe(30 - crate.width);

    const withPlatformSide = {
      ...ELEMENTAL_FOUNDRY_LEVEL,
      platforms: [{ id: 'crate-shelf', x: 30, y: 1, width: 3, element: 'neutral' as const }],
    };
    expect(resolvePlatformerCrateX(crate.x, 31, withPlatformSide)).toBe(30 - crate.width);
  });

  it('walks smoothly up an authored ramp', () => {
    const level = {
      ...ELEMENTAL_GROVE_LEVEL,
      ramps: [
        {
          id: 'test-ramp',
          x: 4,
          y: 0,
          width: 8,
          height: 4,
          direction: 'up-right' as const,
          element: 'neutral' as const,
        },
      ],
    };
    const state = { ...player(), x: 4 - level.playerWidth / 2, y: 0 };
    for (let tick = 0; tick < 12; tick += 1)
      stepPlatformerPlayer(state, input({ moveX: 1 }), STEP, 'ember', level);
    expect(state.y).toBeGreaterThan(0);
    expect(state.grounded).toBe(true);
  });

  it('requires cooperative force before a pushable can enter a ramp', () => {
    const crate = ELEMENTAL_FOUNDRY_LEVEL.mechanics.pushable;
    const level = {
      ...ELEMENTAL_FOUNDRY_LEVEL,
      ramps: [
        {
          id: 'co-op-ramp',
          x: crate.x + crate.width / 2,
          y: 0,
          width: 8,
          height: 4,
          direction: 'up-right' as const,
          element: 'neutral' as const,
        },
      ],
    };
    expect(resolvePlatformerCrateX(crate.x, crate.x + 0.5, level, false, false)).toBe(crate.x);
    expect(resolvePlatformerCrateX(crate.x, crate.x + 0.5, level, false, true)).toBeGreaterThan(
      crate.x,
    );
    const lead = { ...player(), x: crate.x - level.playerWidth };
    const partner = { ...player(), x: lead.x - level.playerWidth };
    expect(
      stepPlatformerCrate(crate.x, [{ player: lead, input: input({ moveX: 1 }) }], STEP.dt, level),
    ).toBe(crate.x);
    expect(
      stepPlatformerCrate(
        crate.x,
        [
          { player: lead, input: input({ moveX: 1 }) },
          { player: partner, input: input({ moveX: 1 }) },
        ],
        STEP.dt,
        level,
      ),
    ).toBeGreaterThan(crate.x);
  });

  it('hands a ramp-supported pushable onto an aligned upper floor', () => {
    const crate = ELEMENTAL_FOUNDRY_LEVEL.mechanics.pushable;
    const level = {
      ...ELEMENTAL_FOUNDRY_LEVEL,
      ramps: [
        {
          id: 'handoff-ramp',
          x: 20,
          y: 0,
          width: 8,
          height: 4,
          direction: 'up-right' as const,
          element: 'neutral' as const,
        },
      ],
      solids: [{ id: 'upper-floor', x: 28, y: 0, width: 10, height: 4 }],
    };
    expect(platformerCrateSupportY(27, level)).toBeCloseTo(4);
    expect(platformerCrateSupportY(29, level)).toBe(4);
    expect(resolvePlatformerCrateX(27, 29, level, false, true)).toBe(29);
    expect(crate.height).toBe(2);
  });

  it('lands on the movable block and carries its rider while another player pushes', () => {
    const crate = ELEMENTAL_FOUNDRY_LEVEL.mechanics.pushable;
    const rider = {
      ...player(),
      x: crate.x + 0.2,
      y: crate.height + 0.05,
      velocityY: -2,
      grounded: false,
    };
    stepPlatformerPlayer(
      rider,
      input(),
      STEP,
      'ember',
      ELEMENTAL_FOUNDRY_LEVEL,
      undefined,
      crate.x,
    );
    expect(rider.y).toBe(crate.height);
    expect(rider.grounded).toBe(true);

    const pusher = { ...player(), x: crate.x + crate.width };
    const riderX = rider.x;
    const nextX = stepPlatformerCrate(
      crate.x,
      [
        { player: pusher, input: input({ moveX: -1 }) },
        { player: rider, input: input() },
      ],
      STEP.dt,
      ELEMENTAL_FOUNDRY_LEVEL,
    );
    expect(rider.x).toBeCloseTo(riderX + nextX - crate.x);
  });

  it('resolves all four sides of dungeon solids', () => {
    const wall = ELEMENTAL_DUNGEON_LEVEL.solids.find((solid) => solid.id === 'lower-floor-right')!;
    const fromLeft = {
      ...player(),
      x: wall.x - ELEMENTAL_DUNGEON_LEVEL.playerWidth - 0.01,
      y: wall.y + 0.1,
    };
    stepPlatformerPlayer(fromLeft, input({ moveX: 1 }), STEP, 'ember', ELEMENTAL_DUNGEON_LEVEL);
    expect(fromLeft.x).toBeCloseTo(wall.x - ELEMENTAL_DUNGEON_LEVEL.playerWidth);

    const fromRight = { ...player(), x: wall.x + wall.width + 0.01, y: wall.y + 0.1 };
    stepPlatformerPlayer(fromRight, input({ moveX: -1 }), STEP, 'ember', ELEMENTAL_DUNGEON_LEVEL);
    expect(fromRight.x).toBeCloseTo(wall.x + wall.width);

    const landing = {
      ...player(),
      x: wall.x + 0.2,
      y: wall.y + wall.height + 0.05,
      velocityY: -2,
      grounded: false,
    };
    stepPlatformerPlayer(landing, input(), STEP, 'ember', ELEMENTAL_DUNGEON_LEVEL);
    expect(landing.y).toBe(wall.y + wall.height);
    expect(landing.grounded).toBe(true);

    const roof = ELEMENTAL_DUNGEON_LEVEL.solids.find((solid) => solid.id === 'dungeon-roof')!;
    const hittingCeiling = {
      ...player(),
      x: roof.x + 1,
      y: roof.y - ELEMENTAL_DUNGEON_LEVEL.playerWidth - 0.02,
      velocityY: 4,
      grounded: false,
    };
    stepPlatformerPlayer(hittingCeiling, input(), STEP, 'ember', ELEMENTAL_DUNGEON_LEVEL);
    expect(hittingCeiling.y + ELEMENTAL_DUNGEON_LEVEL.playerWidth).toBeLessThanOrEqual(roof.y);
    expect(hittingCeiling.velocityY).toBeLessThanOrEqual(0);
  });

  it('cannot jump from the outdoor approach onto the dungeon roof', () => {
    const level = ELEMENTAL_DUNGEON_LEVEL;
    const roof = level.solids.find((solid) => solid.id === 'dungeon-roof')!;
    for (const startingX of [4, 10, 16]) {
      const state = { ...player(), x: startingX, y: level.spawnY.ember };
      let highestY = state.y;
      for (let tick = 0; tick < 90; tick += 1) {
        stepPlatformerPlayer(state, input({ moveX: 1, jump: tick === 0 }), STEP, 'ember', level);
        highestY = Math.max(highestY, state.y);
      }
      expect(highestY, `jump from x=${startingX}`).toBeLessThan(roof.y + roof.height);
      expect(state.y).toBeLessThan(roof.y);
    }
  });

  it('lets the matching spirit cross a hazard and resets the other spirit', () => {
    const hazard = ELEMENTAL_GROVE_LEVEL.hazards[0];
    const matching = { ...player(), x: hazard.x };
    const opposing = { ...player(), x: hazard.x };
    const opposingRole = hazard.safeRole === 'ember' ? 'tide' : 'ember';

    stepPlatformerPlayer(matching, input(), STEP, hazard.safeRole);
    stepPlatformerPlayer(opposing, input(), STEP, opposingRole);

    expect(matching.x).toBe(hazard.x);
    expect(opposing.x).toBe(ELEMENTAL_GROVE_LEVEL.spawns[opposingRole]);
  });
});
