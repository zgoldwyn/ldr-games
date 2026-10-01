import {
  ELEMENTAL_GROVE_LEVEL,
  elementalRampSurfaceY,
  elementalCrystalMaskForRole,
  type ElementalLevel,
  type ElementalRole,
} from '@ldr/core';

import type { PlatformerInput } from './input.js';

export interface MutablePlayerKinematics {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  grounded: boolean;
}

export interface FixedStepContext {
  readonly dt: number;
  readonly subSteps: number;
  readonly subDt: number;
}

/** Levers toggle on an interaction edge, never repeatedly while the control is held. */
export function nextPlatformerLeverActivated(
  current: boolean,
  interact: boolean,
  wasHeld: boolean,
  inReach: boolean,
): boolean {
  return interact && !wasHeld && inReach ? !current : current;
}

/** The shared clock counts only active, unfinished simulation ticks. */
export function nextPlatformerElapsedTicks(
  elapsedTicks: number,
  bothConnected: boolean,
  completed: boolean,
): number {
  return bothConnected && !completed ? elapsedTicks + 1 : elapsedTicks;
}

export const PLATFORMER_WORLD = {
  minX: 0,
  maxX: ELEMENTAL_GROVE_LEVEL.width - ELEMENTAL_GROVE_LEVEL.playerWidth,
  floorY: 0,
  moveSpeed: ELEMENTAL_GROVE_LEVEL.moveSpeed,
  jumpSpeed: ELEMENTAL_GROVE_LEVEL.jumpSpeed,
  gravity: ELEMENTAL_GROVE_LEVEL.gravity,
} as const;

export interface PlatformerGateState {
  readonly emberAtGate: boolean;
  readonly tideAtGate: boolean;
  readonly completed: boolean;
}

function playerIsGroundedAtGate(
  player: Readonly<MutablePlayerKinematics> | undefined,
  role: 'ember' | 'tide',
  level: ElementalLevel,
): boolean {
  if (!player || !player.grounded) {
    return false;
  }
  const gate = level.gates[role];
  return (
    Math.abs(player.y - gate.y) <= 0.01 &&
    player.x + level.playerWidth > gate.x &&
    player.x < gate.x + gate.width
  );
}

/** A cooperative clear only occurs while both characters occupy their own gates. */
export function evaluatePlatformerGates(
  ember: Readonly<MutablePlayerKinematics> | undefined,
  tide: Readonly<MutablePlayerKinematics> | undefined,
  unlocked: Readonly<{ ember: boolean; tide: boolean }>,
  level: ElementalLevel = ELEMENTAL_GROVE_LEVEL,
): PlatformerGateState {
  const emberAtGate = unlocked.ember && playerIsGroundedAtGate(ember, 'ember', level);
  const tideAtGate = unlocked.tide && playerIsGroundedAtGate(tide, 'tide', level);
  return { emberAtGate, tideAtGate, completed: emberAtGate && tideAtGate };
}

/** Collect role-matched crystals into one shared, monotonic room bitmask. */
export function collectPlatformerCrystals(
  ember: Readonly<MutablePlayerKinematics> | undefined,
  tide: Readonly<MutablePlayerKinematics> | undefined,
  currentMask: number,
  level: ElementalLevel = ELEMENTAL_GROVE_LEVEL,
): number {
  let mask = currentMask & ((1 << level.crystals.length) - 1);
  level.crystals.forEach((crystal, index) => {
    const bit = 1 << index;
    if ((mask & bit) !== 0) return;
    const player = crystal.role === 'ember' ? ember : tide;
    if (!player) return;
    const centerX = player.x + level.playerWidth / 2;
    const overlapsX = Math.abs(centerX - crystal.x) <= level.playerWidth * 0.75;
    const overlapsY =
      crystal.y >= player.y - 0.25 && crystal.y <= player.y + level.playerWidth + 0.45;
    if (overlapsX && overlapsY) mask |= bit;
  });
  return mask;
}

export function resetPlatformerCrystalsForRole(
  currentMask: number,
  role: ElementalRole,
  level: ElementalLevel = ELEMENTAL_GROVE_LEVEL,
): number {
  return currentMask & ~elementalCrystalMaskForRole(role, level);
}

/**
 * Shared deterministic movement kernel. The mobile prediction path should
 * import this function rather than implement a second movement equation.
 */
export function stepPlatformerPlayer(
  player: MutablePlayerKinematics,
  input: Readonly<PlatformerInput>,
  context: FixedStepContext,
  role: ElementalRole = 'ember',
  level: ElementalLevel = ELEMENTAL_GROVE_LEVEL,
  disabledHazardId?: string,
  crateX?: number,
  activatedPlatformActive = false,
): boolean {
  const moveX = input.moveX === -1 || input.moveX === 1 ? input.moveX : 0;
  player.velocityX = moveX * level.moveSpeed;

  // Jump is an impulse and is intentionally applied once per input step, not
  // once per physics substep.
  if (input.jump && player.grounded) {
    player.velocityY = level.jumpSpeed;
    player.grounded = false;
  }

  for (let index = 0; index < context.subSteps; index += 1) {
    player.velocityY += level.gravity * context.subDt;
    const previousX = player.x;
    const previousY = player.y;
    player.x = Math.max(
      0,
      Math.min(level.width - level.playerWidth, player.x + player.velocityX * context.subDt),
    );
    const horizontalSolid = level.solids.find((solid) => {
      const overlapsVertically =
        previousY < solid.y + solid.height && previousY + level.playerWidth > solid.y;
      if (!overlapsVertically) return false;
      return player.velocityX > 0
        ? previousX + level.playerWidth <= solid.x && player.x + level.playerWidth > solid.x
        : player.velocityX < 0
          ? previousX >= solid.x + solid.width && player.x < solid.x + solid.width
          : false;
    });
    if (horizontalSolid) {
      player.x =
        player.velocityX > 0
          ? horizontalSolid.x - level.playerWidth
          : horizontalSolid.x + horizontalSolid.width;
      player.velocityX = 0;
    }
    player.y += player.velocityY * context.subDt;
    if (previousY > PLATFORMER_WORLD.floorY) player.grounded = false;
    const solidLanding = level.solids.find(
      (solid) =>
        player.velocityY <= 0 &&
        previousY >= solid.y + solid.height &&
        player.y <= solid.y + solid.height &&
        player.x + level.playerWidth > solid.x &&
        player.x < solid.x + solid.width,
    );
    if (solidLanding) {
      player.y = solidLanding.y + solidLanding.height;
      player.velocityY = 0;
      player.grounded = true;
      continue;
    }
    const solidCeiling = level.solids.find(
      (solid) =>
        player.velocityY > 0 &&
        previousY + level.playerWidth <= solid.y &&
        player.y + level.playerWidth >= solid.y &&
        player.x + level.playerWidth > solid.x &&
        player.x < solid.x + solid.width,
    );
    if (solidCeiling) {
      player.y = solidCeiling.y - level.playerWidth;
      player.velocityY = 0;
    }
    const activePlatforms =
      'mechanics' in level && activatedPlatformActive
        ? [...level.platforms, level.mechanics.activatedPlatform]
        : level.platforms;
    const landedPlatform = activePlatforms.find(
      (platform) =>
        (platform.element === 'neutral' || platform.element === role) &&
        player.velocityY <= 0 &&
        previousY >= platform.y &&
        player.y <= platform.y &&
        player.x + level.playerWidth > platform.x &&
        player.x < platform.x + platform.width,
    );
    if (landedPlatform) {
      player.y = landedPlatform.y;
      player.velocityY = 0;
      player.grounded = true;
      continue;
    }
    const playerCenterX = player.x + level.playerWidth / 2;
    const previousCenterX = previousX + level.playerWidth / 2;
    const landedRamp = (level.ramps ?? []).find((ramp) => {
      if (ramp.element !== 'neutral' && ramp.element !== role) return false;
      if (playerCenterX < ramp.x || playerCenterX > ramp.x + ramp.width) return false;
      const surfaceY = elementalRampSurfaceY(ramp, playerCenterX);
      const previousSurfaceY = elementalRampSurfaceY(ramp, previousCenterX);
      return (
        player.velocityY <= 0 && previousY >= previousSurfaceY - 0.12 && player.y <= surfaceY + 0.12
      );
    });
    if (landedRamp) {
      player.y = elementalRampSurfaceY(landedRamp, playerCenterX);
      player.velocityY = 0;
      player.grounded = true;
      // A player supported by a ramp can still run into the crate on this step.
    }
    if ('mechanics' in level && crateX !== undefined) {
      const crate = level.mechanics.pushable;
      const crateY = platformerCrateSupportY(crateX, level);
      const overlapsCrate =
        player.x + level.playerWidth > crateX && player.x < crateX + crate.width;
      if (
        overlapsCrate &&
        player.velocityY <= 0 &&
        previousY >= crateY + crate.height &&
        player.y <= crateY + crate.height
      ) {
        player.y = crateY + crate.height;
        player.velocityY = 0;
        player.grounded = true;
        continue;
      }
      if (player.y < crateY + crate.height - 0.05 && player.y + level.playerWidth > crateY) {
        const previousCenter = player.x - player.velocityX * context.subDt + level.playerWidth / 2;
        const crateCenter = crateX + crate.width / 2;
        if (previousCenter <= crateCenter && player.x + level.playerWidth > crateX) {
          player.x = crateX - level.playerWidth;
        } else if (previousCenter > crateCenter && player.x < crateX + crate.width) {
          player.x = crateX + crate.width;
        }
      }
    }
    if (landedRamp) {
      player.y = elementalRampSurfaceY(landedRamp, player.x + level.playerWidth / 2);
      continue;
    }
    if (player.y <= PLATFORMER_WORLD.floorY) {
      player.y = PLATFORMER_WORLD.floorY;
      player.velocityY = 0;
      player.grounded = true;
    }
    const centerX = player.x + level.playerWidth / 2;
    const wrongHazard = level.hazards.find(
      (hazard) =>
        hazard.id !== disabledHazardId &&
        role !== hazard.safeRole &&
        player.y <= 0.05 &&
        centerX >= hazard.x &&
        centerX <= hazard.x + hazard.width,
    );
    if (wrongHazard) {
      player.x = level.spawns[role];
      player.y = level.spawnY[role];
      player.velocityX = 0;
      player.velocityY = 0;
      player.grounded = true;
      return true;
    }
  }
  return false;
}

export interface PlatformerCratePusher {
  readonly player: MutablePlayerKinematics;
  readonly input: Pick<PlatformerInput, 'moveX'>;
}

export function platformerCrateSupportY(crateX: number, level: ElementalLevel): number {
  if (!('mechanics' in level)) return 0;
  const crate = level.mechanics.pushable;
  const centerX = crateX + crate.width / 2;
  const ramp = (level.ramps ?? []).find(
    (candidate) => centerX >= candidate.x - 1e-6 && centerX <= candidate.x + candidate.width + 1e-6,
  );
  if (ramp) return elementalRampSurfaceY(ramp, centerX);
  for (const candidate of level.ramps ?? []) {
    const highX = candidate.direction === 'up-right' ? candidate.x + candidate.width : candidate.x;
    const highY = candidate.y + candidate.height;
    const connectedSurfaces = [
      ...level.solids.map((solid) => ({
        x: solid.x,
        width: solid.width,
        y: solid.y + solid.height,
      })),
      ...level.platforms.map((platform) => ({
        x: platform.x,
        width: platform.width,
        y: platform.y,
      })),
    ];
    const support = connectedSurfaces.find((surface) => {
      const joined =
        candidate.direction === 'up-right'
          ? Math.abs(surface.x - highX) <= 0.15
          : Math.abs(surface.x + surface.width - highX) <= 0.15;
      return (
        joined &&
        Math.abs(surface.y - highY) <= 0.15 &&
        centerX >= surface.x &&
        centerX <= surface.x + surface.width
      );
    });
    if (support) return support.y;
  }
  return crate.y;
}

/** Resolves a pushable against world edges and authored solid/platform sides. */
export function resolvePlatformerCrateX(
  crateX: number,
  proposedX: number,
  level: ElementalLevel,
  activatedPlatformActive = false,
  allowRampTraversal = false,
): number {
  if (!('mechanics' in level)) return crateX;
  const crate = level.mechanics.pushable;
  let resolved = Math.max(0, Math.min(level.width - crate.width, proposedX));
  const currentCenter = crateX + crate.width / 2;
  const proposedCenter = resolved + crate.width / 2;
  const touchesRamp = (level.ramps ?? []).some(
    (ramp) =>
      (currentCenter >= ramp.x && currentCenter <= ramp.x + ramp.width) ||
      (proposedCenter >= ramp.x && proposedCenter <= ramp.x + ramp.width),
  );
  if (touchesRamp && !allowRampTraversal) return crateX;
  for (const ramp of level.ramps ?? []) {
    const highEdge = ramp.direction === 'up-right' ? ramp.x + ramp.width : ramp.x;
    const crossedHighEdge =
      ramp.direction === 'up-right'
        ? currentCenter <= highEdge + 1e-6 && proposedCenter > highEdge
        : currentCenter >= highEdge - 1e-6 && proposedCenter < highEdge;
    if (!crossedHighEdge) continue;
    const beyondCenter = highEdge + (ramp.direction === 'up-right' ? 0.01 : -0.01);
    const upperSupport = platformerCrateSupportY(beyondCenter - crate.width / 2, level);
    if (upperSupport < ramp.y + ramp.height - 0.15)
      resolved = highEdge - crate.width / 2;
  }
  const crateY = platformerCrateSupportY(resolved, level);
  const platforms = activatedPlatformActive
    ? [...level.platforms, level.mechanics.activatedPlatform]
    : level.platforms;
  const blockers = [
    ...level.solids,
    ...platforms.map((platform) => ({
      x: platform.x,
      y: platform.y - 0.12,
      width: platform.width,
      height: 0.24,
    })),
  ].filter((blocker) => crateY < blocker.y + blocker.height && crateY + crate.height > blocker.y);
  if (resolved > crateX) {
    for (const blocker of blockers) {
      if (crateX + crate.width <= blocker.x && resolved + crate.width > blocker.x)
        resolved = Math.min(resolved, blocker.x - crate.width);
    }
  } else if (resolved < crateX) {
    for (const blocker of blockers) {
      const edge = blocker.x + blocker.width;
      if (crateX >= edge && resolved < edge) resolved = Math.max(resolved, edge);
    }
  }
  return resolved;
}

/** Moves the level-two weight once per tick and keeps grounded players on their contact side. */
export function stepPlatformerCrate(
  crateX: number,
  pushers: readonly PlatformerCratePusher[],
  dt: number,
  level: ElementalLevel,
  activatedPlatformActive = false,
): number {
  if (!('mechanics' in level)) return crateX;
  const crate = level.mechanics.pushable;
  const crateY = platformerCrateSupportY(crateX, level);
  const crateCenter = crateX + crate.width / 2;
  const contactSlop = 0.35;
  const contacts = pushers.filter(({ player, input }) => {
    const overlapsVertically =
      player.y < crateY + crate.height && player.y + level.playerWidth > crateY;
    if (!player.grounded || !overlapsVertically || input.moveX === 0) return false;
    const playerCenter = player.x + level.playerWidth / 2;
    if (input.moveX === 1) {
      return playerCenter < crateCenter && player.x + level.playerWidth >= crateX - contactSlop;
    }
    return playerCenter > crateCenter && player.x <= crateX + crate.width + contactSlop;
  });
  const directions = new Set(contacts.map(({ input }) => input.moveX));
  const direction = directions.size === 1 ? contacts[0]?.input.moveX : 0;
  const cooperativeRampPush =
    direction !== 0 &&
    pushers.filter(({ player, input }) => {
      if (!player.grounded || input.moveX !== direction) return false;
      const playerCenter = player.x + level.playerWidth / 2;
      return direction === 1
        ? playerCenter < crateCenter &&
            player.x + level.playerWidth >= crateX - level.playerWidth * 1.5
        : playerCenter > crateCenter && player.x <= crateX + crate.width + level.playerWidth * 1.5;
    }).length >= 2;
  const nextX = resolvePlatformerCrateX(
    crateX,
    crateX + (direction ?? 0) * crate.pushSpeed * dt,
    level,
    activatedPlatformActive,
    cooperativeRampPush,
  );
  const deltaX = nextX - crateX;

  for (const { player } of pushers) {
    const standingOnCrate =
      player.grounded &&
      Math.abs(player.y - (crateY + crate.height)) <= 0.08 &&
      player.x + level.playerWidth > crateX &&
      player.x < crateX + crate.width;
    if (standingOnCrate) {
      player.x = Math.max(0, Math.min(level.width - level.playerWidth, player.x + deltaX));
      continue;
    }
    if (
      !player.grounded ||
      player.y >= crateY + crate.height ||
      player.y + level.playerWidth <= crateY
    )
      continue;
    const playerCenter = player.x + level.playerWidth / 2;
    if (playerCenter <= crateCenter && player.x + level.playerWidth > nextX) {
      player.x = nextX - level.playerWidth;
    } else if (playerCenter > crateCenter && player.x < nextX + crate.width) {
      player.x = nextX + crate.width;
    }
  }
  return nextX;
}
