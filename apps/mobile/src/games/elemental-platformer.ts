export const ELEMENTAL_VIEWPORT_WIDTH = 320;
export const ELEMENTAL_WORLD_WIDTH = 760;
export const ELEMENTAL_WORLD_HEIGHT = 220;
export const ELEMENTAL_PLAYER_SIZE = 26;
export const ELEMENTAL_FLOOR_Y = 184;
export const ELEMENTAL_PLATFORMS = [
  { x: 126, y: 150, width: 150, height: 12 },
  { x: 326, y: 118, width: 112, height: 12 },
  { x: 506, y: 148, width: 126, height: 12 },
] as const;
export const ELEMENTAL_PLATFORM = ELEMENTAL_PLATFORMS[0];
export const ELEMENTAL_GATES = {
  ember: { x: 18, y: 130, width: 34, height: 54 },
  tide: { x: 708, y: 130, width: 34, height: 54 },
} as const;

const RUN_SPEED = 136;
const RUN_ACCELERATION = 780;
const RUN_FRICTION = 900;
const GRAVITY = 620;
const JUMP_SPEED = 248;

export type ElementalPlayerState = {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly grounded: boolean;
};

export type ElementalInput = {
  readonly horizontal: -1 | 0 | 1;
  readonly jumpPressed: boolean;
};

/** One uniform scale keeps the 320×220 camera viewport proportional. */
export function elementalStageScale(renderedWidth: number): number {
  return Math.max(0, renderedWidth) / ELEMENTAL_VIEWPORT_WIDTH;
}

export function elementalCameraOffset(
  playerX: number,
  scale: number,
  viewportWidth: number,
  worldWidth: number,
): number {
  'worklet';
  const wanted = playerX * scale - viewportWidth * 0.42;
  return Math.max(0, Math.min(wanted, Math.max(0, worldWidth - viewportWidth)));
}

/** Translate the world so the player stays visible between the ceiling and floor limits. */
export function elementalVerticalCameraOffset(
  playerTop: number,
  viewportHeight: number,
  worldHeight: number,
): number {
  'worklet';
  if (worldHeight <= viewportHeight) return (viewportHeight - worldHeight) / 2;
  const wanted = viewportHeight * 0.52 - playerTop;
  return Math.max(viewportHeight - worldHeight, Math.min(0, wanted));
}

export function elementalSpectatorZoom(viewportWidth: number, worldWidth: number): number {
  'worklet';
  if (worldWidth <= 0) return 1;
  return Math.max(0.25, Math.min(1, viewportWidth / worldWidth));
}

function approach(value: number, target: number, amount: number): number {
  'worklet';
  if (value < target) return Math.min(value + amount, target);
  if (value > target) return Math.max(value - amount, target);
  return value;
}

/** Deterministic movement and landing collision for the tutorial level. */
export function stepElementalPlayer(
  state: ElementalPlayerState,
  input: ElementalInput,
  elapsedSeconds: number,
): ElementalPlayerState {
  'worklet';
  const dt = Math.max(0, Math.min(elapsedSeconds, 1 / 30));
  const targetVx = input.horizontal * RUN_SPEED;
  const acceleration = input.horizontal === 0 ? RUN_FRICTION : RUN_ACCELERATION;
  const vx = approach(state.vx, targetVx, acceleration * dt);
  let vy = input.jumpPressed && state.grounded ? -JUMP_SPEED : state.vy;
  vy += GRAVITY * dt;

  const maxX = ELEMENTAL_WORLD_WIDTH - ELEMENTAL_PLAYER_SIZE;
  const x = Math.max(0, Math.min(state.x + vx * dt, maxX));
  const floorTop = ELEMENTAL_FLOOR_Y - ELEMENTAL_PLAYER_SIZE;
  const proposedY = state.y + vy * dt;
  const landedPlatform = ELEMENTAL_PLATFORMS.find(
    (platform) =>
      x + ELEMENTAL_PLAYER_SIZE > platform.x &&
      x < platform.x + platform.width &&
      state.y + ELEMENTAL_PLAYER_SIZE <= platform.y &&
      proposedY + ELEMENTAL_PLAYER_SIZE >= platform.y,
  );

  if (vy >= 0 && landedPlatform) {
    return {
      x,
      y: landedPlatform.y - ELEMENTAL_PLAYER_SIZE,
      vx,
      vy: 0,
      grounded: true,
    };
  }

  if (proposedY >= floorTop) {
    return { x, y: floorTop, vx, vy: 0, grounded: true };
  }
  return { x, y: proposedY, vx, vy, grounded: false };
}

export function isElementalPlayerOnPlatform(state: ElementalPlayerState): boolean {
  'worklet';
  if (!state.grounded) return false;
  return ELEMENTAL_PLATFORMS.some(
    (platform) => Math.abs(state.y - (platform.y - ELEMENTAL_PLAYER_SIZE)) < 0.1,
  );
}

/** Gate completion requires the player's center to be inside the matching portal in both axes. */
export function isElementalPlayerAtGate(
  role: 'ember' | 'tide',
  state: Pick<ElementalPlayerState, 'x' | 'y'>,
): boolean {
  'worklet';
  const gate = role === 'ember' ? ELEMENTAL_GATES.ember : ELEMENTAL_GATES.tide;
  const centerX = state.x + ELEMENTAL_PLAYER_SIZE / 2;
  const centerY = state.y + ELEMENTAL_PLAYER_SIZE / 2;
  return (
    centerX >= gate.x &&
    centerX <= gate.x + gate.width &&
    centerY >= gate.y &&
    centerY <= gate.y + gate.height
  );
}
