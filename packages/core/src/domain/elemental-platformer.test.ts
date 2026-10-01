import { describe, expect, it } from 'vitest';

import { accountId } from './common.js';
import {
  countCollectedElementalCrystals,
  ELEMENTAL_AUTHORED_LEVELS,
  ELEMENTAL_ALL_CRYSTALS_MASK,
  ELEMENTAL_EMBER_CRYSTALS_MASK,
  ELEMENTAL_FOUNDRY_LEVEL,
  ELEMENTAL_GROVE_LEVEL,
  ELEMENTAL_DUNGEON_LEVEL,
  ELEMENTAL_TIDE_CRYSTALS_MASK,
  assignElementalRoles,
  elementalCatalogFingerprint,
  elementalLevelFingerprint,
  elementalLevel,
  elementalRoleHasRequiredCrystals,
  elementalRoleFor,
  oppositeElementalRole,
} from './elemental-platformer.js';

const CREATOR = accountId('creator');
const PARTNER = accountId('linked-partner');

describe('elemental platformer roles', () => {
  it('uses one contiguous level number as both identity and live sequence', () => {
    expect(ELEMENTAL_AUTHORED_LEVELS.map((level) => level.number)).toEqual([1, 2, 3]);
    for (const level of ELEMENTAL_AUTHORED_LEVELS) expect(elementalLevel(level.number)).toBe(level);
  });

  it('never asks for more crystals than a live level places', () => {
    for (const level of ELEMENTAL_AUTHORED_LEVELS) {
      expect(level.crystals.length).toBeLessThanOrEqual(16);
      for (const role of ['ember', 'tide'] as const) {
        const available = level.crystals.filter((crystal) => crystal.role === role).length;
        expect(level.requiredCrystals[role]).toBeGreaterThanOrEqual(0);
        expect(level.requiredCrystals[role]).toBeLessThanOrEqual(available);
      }
    }
  });

  it('tracks the shared crystal set with a compact mask', () => {
    expect(countCollectedElementalCrystals(0)).toBe(0);
    expect(countCollectedElementalCrystals(0b010101)).toBe(3);
    expect(countCollectedElementalCrystals(ELEMENTAL_ALL_CRYSTALS_MASK)).toBe(
      ELEMENTAL_GROVE_LEVEL.crystals.length,
    );
    expect(ELEMENTAL_EMBER_CRYSTALS_MASK & ELEMENTAL_TIDE_CRYSTALS_MASK).toBe(0);
    expect(ELEMENTAL_EMBER_CRYSTALS_MASK | ELEMENTAL_TIDE_CRYSTALS_MASK).toBe(
      ELEMENTAL_ALL_CRYSTALS_MASK,
    );
  });

  it.each(['ember', 'tide'] as const)(
    'assigns the creator %s and the linked partner the opposite role',
    (creatorRole) => {
      const assignment = assignElementalRoles(CREATOR, PARTNER, creatorRole);

      expect(elementalRoleFor(assignment, CREATOR)).toBe(creatorRole);
      expect(elementalRoleFor(assignment, PARTNER)).toBe(oppositeElementalRole(creatorRole));
    },
  );

  it('does not assign a role to an account outside the paired session', () => {
    const assignment = assignElementalRoles(CREATOR, PARTNER, 'ember');
    expect(elementalRoleFor(assignment, accountId('stranger'))).toBeNull();
  });

  it('keeps every authored obstacle inside the grove', () => {
    for (const level of [ELEMENTAL_GROVE_LEVEL, ELEMENTAL_FOUNDRY_LEVEL, ELEMENTAL_DUNGEON_LEVEL]) {
      for (const platform of level.platforms) {
        expect(platform.x).toBeGreaterThanOrEqual(0);
        expect(platform.x + platform.width).toBeLessThanOrEqual(level.width);
      }
      for (const hazard of level.hazards) {
        expect(hazard.x + hazard.width).toBeLessThanOrEqual(level.width);
      }
      for (const solid of level.solids) {
        expect(solid.x).toBeGreaterThanOrEqual(0);
        expect(solid.x + solid.width).toBeLessThanOrEqual(level.width);
        expect(solid.y).toBeGreaterThanOrEqual(0);
        expect(solid.height).toBeGreaterThan(0);
      }
      for (const crystal of level.crystals) {
        expect(crystal.x).toBeGreaterThanOrEqual(0);
        expect(crystal.x).toBeLessThanOrEqual(level.width);
        expect(crystal.y).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every gate portal clear of every platform', () => {
    for (const level of [ELEMENTAL_GROVE_LEVEL, ELEMENTAL_FOUNDRY_LEVEL, ELEMENTAL_DUNGEON_LEVEL]) {
      for (const platform of level.platforms) {
        for (const gate of Object.values(level.gates)) {
          const overlapsHorizontally =
            platform.x < gate.x + gate.width && platform.x + platform.width > gate.x;
          // The rendered portal is just under five world units tall.
          const overlapsVertically = platform.y >= gate.y && platform.y <= gate.y + 5;
          const overlaps = overlapsHorizontally && overlapsVertically;
          expect(overlaps, `${level.id}: ${platform.id} overlaps a gate`).toBe(false);
        }
      }
      for (const solid of level.solids) {
        for (const gate of Object.values(level.gates)) {
          const overlapsHorizontally =
            solid.x < gate.x + gate.width && solid.x + solid.width > gate.x;
          const overlapsVertically = solid.y < gate.y + 5 && solid.y + solid.height > gate.y;
          expect(
            overlapsHorizontally && overlapsVertically,
            `${level.id}: ${solid.id} intersects a gate`,
          ).toBe(false);
        }
      }
    }
  });

  it('builds level three as an outdoor entrance over three underground floors', () => {
    const approach = ELEMENTAL_DUNGEON_LEVEL.solids.find(
      (solid) => solid.id === 'outside-approach',
    )!;
    expect(ELEMENTAL_DUNGEON_LEVEL.spawnY.ember).toBe(approach.height);
    expect(ELEMENTAL_DUNGEON_LEVEL.spawnY.tide).toBe(approach.height);
    expect(ELEMENTAL_DUNGEON_LEVEL.platforms[0]!.id).toBe('entrance-step');
    const roof = ELEMENTAL_DUNGEON_LEVEL.solids.find((solid) => solid.id === 'dungeon-roof')!;
    const maximumJumpRise =
      (ELEMENTAL_DUNGEON_LEVEL.jumpSpeed * ELEMENTAL_DUNGEON_LEVEL.jumpSpeed) /
      (-2 * ELEMENTAL_DUNGEON_LEVEL.gravity);
    expect(roof.y + roof.height).toBeGreaterThan(approach.height + maximumJumpRise);
    expect(roof.y - approach.height).toBeGreaterThan(ELEMENTAL_DUNGEON_LEVEL.playerWidth);

    const solid = (id: string) =>
      ELEMENTAL_DUNGEON_LEVEL.solids.find((candidate) => candidate.id === id)!;
    const upperSurface = solid('upper-floor-left').y + solid('upper-floor-left').height;
    const middleSurface = solid('middle-floor-left').y + solid('middle-floor-left').height;
    const lowerSurface = solid('lower-floor-right').y + solid('lower-floor-right').height;
    expect(upperSurface).toBeCloseTo(12.6);
    expect(middleSurface).toBeCloseTo(8.3);
    expect(lowerSurface).toBeCloseTo(4);
    expect(upperSurface).toBeLessThan(approach.height);
    expect(middleSurface).toBeLessThan(upperSurface);
    expect(lowerSurface).toBeLessThan(middleSurface);

    const emberShards = ELEMENTAL_DUNGEON_LEVEL.crystals.filter(
      (crystal) => crystal.role === 'ember',
    );
    const tideShards = ELEMENTAL_DUNGEON_LEVEL.crystals.filter(
      (crystal) => crystal.role === 'tide',
    );
    expect(emberShards.map((crystal) => crystal.y)).toEqual([13.85, 9.55, 1.25]);
    expect(tideShards.map((crystal) => crystal.y)).toEqual([13.85, 9.55, 1.25]);
    expect(emberShards[2]!.x).toBeGreaterThan(ELEMENTAL_DUNGEON_LEVEL.width / 2);
    expect(tideShards[2]!.x).toBeLessThan(ELEMENTAL_DUNGEON_LEVEL.width / 2);
  });

  it('fingerprints all authored properties and invalidates the whole catalog on edits', () => {
    const edited = {
      ...ELEMENTAL_DUNGEON_LEVEL,
      solids: ELEMENTAL_DUNGEON_LEVEL.solids.map((solid) =>
        solid.id === 'dungeon-roof' ? { ...solid, height: solid.height + 1 } : solid,
      ),
    } as unknown as typeof ELEMENTAL_DUNGEON_LEVEL;
    expect(elementalLevelFingerprint(ELEMENTAL_DUNGEON_LEVEL)).toBe(
      elementalLevelFingerprint({ ...ELEMENTAL_DUNGEON_LEVEL }),
    );
    expect(elementalLevelFingerprint(edited)).not.toBe(
      elementalLevelFingerprint(ELEMENTAL_DUNGEON_LEVEL),
    );
    expect(
      elementalCatalogFingerprint([ELEMENTAL_GROVE_LEVEL, ELEMENTAL_FOUNDRY_LEVEL, edited]),
    ).not.toBe(elementalCatalogFingerprint());
  });

  it('opens each gate after its own authored crystal requirement', () => {
    const level = {
      ...ELEMENTAL_GROVE_LEVEL,
      requiredCrystals: { ember: 2, tide: 1 },
    };
    const emberBits = level.crystals.flatMap((crystal, index) =>
      crystal.role === 'ember' ? [1 << index] : [],
    );
    const tideBit = 1 << level.crystals.findIndex((crystal) => crystal.role === 'tide');
    expect(elementalRoleHasRequiredCrystals('ember', emberBits[0]!, level)).toBe(false);
    expect(elementalRoleHasRequiredCrystals('ember', emberBits[0]! | tideBit, level)).toBe(false);
    expect(elementalRoleHasRequiredCrystals('ember', emberBits[0]! | emberBits[1]!, level)).toBe(
      true,
    );
    expect(elementalRoleHasRequiredCrystals('tide', tideBit, level)).toBe(true);
    expect(
      elementalRoleHasRequiredCrystals('ember', 0, {
        ...level,
        requiredCrystals: { ember: 0, tide: 1 },
      }),
    ).toBe(true);
  });

  it('keeps the current level-two crystal-free route governed by its mechanisms', () => {
    expect(ELEMENTAL_FOUNDRY_LEVEL.requiredCrystals).toEqual({ ember: 0, tide: 0 });
    expect(elementalRoleHasRequiredCrystals('ember', 0, ELEMENTAL_FOUNDRY_LEVEL)).toBe(true);
    expect(ELEMENTAL_FOUNDRY_LEVEL.hazards.some((hazard) => hazard.safeRole === 'none')).toBe(true);
    expect(ELEMENTAL_FOUNDRY_LEVEL.mechanics).toMatchObject({
      pushable: expect.any(Object),
      pressurePlate: expect.any(Object),
      lever: expect.any(Object),
      activatedPlatform: expect.any(Object),
    });
  });

  it('keeps the level-two vertical staircase within the authored jump arc', () => {
    const maxRise =
      (ELEMENTAL_FOUNDRY_LEVEL.jumpSpeed * ELEMENTAL_FOUNDRY_LEVEL.jumpSpeed) /
      (-2 * ELEMENTAL_FOUNDRY_LEVEL.gravity);
    const heights = [0, 2, 4.8, 7.4, 10.1, 12.8, 15.5];
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]! - heights[index - 1]!).toBeLessThan(maxRise);
    }
  });

  it('makes the lever chasm wider than the maximum full-speed jump', () => {
    const chasm = ELEMENTAL_FOUNDRY_LEVEL.hazards.find(
      (hazard) => hazard.id === ELEMENTAL_FOUNDRY_LEVEL.mechanics.activatedPlatform.hazardId,
    )!;
    const airborneSeconds =
      (2 * ELEMENTAL_FOUNDRY_LEVEL.jumpSpeed) / -ELEMENTAL_FOUNDRY_LEVEL.gravity;
    const maximumJumpDistance = ELEMENTAL_FOUNDRY_LEVEL.moveSpeed * airborneSeconds;
    expect(chasm.width).toBeGreaterThan(maximumJumpDistance);
    expect(ELEMENTAL_FOUNDRY_LEVEL.mechanics.lever.x).toBeGreaterThan(chasm.x + chasm.width);
  });

  it('keeps low platforms from covering the visible poison pools', () => {
    const lowPlatforms = ELEMENTAL_FOUNDRY_LEVEL.platforms.filter((platform) => platform.y <= 4.7);
    for (const platform of lowPlatforms) {
      for (const hazard of ELEMENTAL_FOUNDRY_LEVEL.hazards) {
        const overlaps =
          platform.x < hazard.x + hazard.width && platform.x + platform.width > hazard.x;
        expect(overlaps, `${platform.id} overlaps ${hazard.id}`).toBe(false);
      }
    }
  });

  it('keeps the level-two weight route on solid ground with its switch in reach', () => {
    const { pushable: crate, pressurePlate: button, lever } = ELEMENTAL_FOUNDRY_LEVEL.mechanics;
    const routeStart = Math.min(crate.x, button.x);
    const routeEnd = Math.max(crate.x + crate.width, button.x + button.width);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeLessThanOrEqual(ELEMENTAL_FOUNDRY_LEVEL.width);
    for (const hazard of ELEMENTAL_FOUNDRY_LEVEL.hazards) {
      const trackOverlapsHazard = routeEnd > hazard.x && routeStart < hazard.x + hazard.width;
      expect(trackOverlapsHazard).toBe(false);
    }
    const buttonEnd = button.x + button.width;
    expect(lever.x).toBeGreaterThan(buttonEnd + 2);
    const firstHazardToTheRight = ELEMENTAL_FOUNDRY_LEVEL.hazards
      .filter((hazard) => hazard.x > crate.x)
      .sort((first, second) => first.x - second.x)[0]!;
    const rightSideStandingEnd = crate.x + crate.width + ELEMENTAL_FOUNDRY_LEVEL.playerWidth;
    expect(firstHazardToTheRight.x - rightSideStandingEnd).toBeGreaterThanOrEqual(3);
  });
});
