import type { AccountId } from './common.js';
import { ELEMENTAL_PUBLISHED_LEVELS } from './elemental-published-levels.js';

export const ELEMENTAL_PLATFORMER_GAME_ID = 'elemental-platformer';

export type ElementalRole = 'ember' | 'tide';

export interface ElementalLevelBase {
  readonly number: number;
  readonly id: string;
  readonly name: string;
  readonly chapter: string;
  readonly width: number;
  readonly playerWidth: number;
  readonly moveSpeed: number;
  readonly jumpSpeed: number;
  readonly gravity: number;
  readonly spawns: Readonly<Record<ElementalRole, number>>;
  readonly spawnY: Readonly<Record<ElementalRole, number>>;
  readonly gates: Readonly<
    Record<ElementalRole, { readonly x: number; readonly y: number; readonly width: number }>
  >;
  readonly solids: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly platforms: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly element: ElementalRole | 'neutral';
  }[];
  readonly ramps?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly direction: 'up-left' | 'up-right';
    readonly element: ElementalRole | 'neutral';
  }[];
  readonly hazards: readonly {
    readonly id: string;
    readonly x: number;
    readonly width: number;
    readonly safeRole: ElementalRole | 'none';
  }[];
  readonly crystals: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly role: ElementalRole;
  }[];
  readonly requiredCrystals: Readonly<Record<ElementalRole, number>>;
  readonly environmentZones?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly environment: 'outside' | 'underground';
  }[];
  readonly entrances?: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly from: 'outside' | 'underground';
    readonly to: 'outside' | 'underground';
  }[];
}

export interface ElementalMechanics {
  readonly pushable: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly pushSpeed: number;
  };
  readonly pressurePlate: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly target: 'gates' | 'activatedPlatform';
  };
  readonly lever: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly reach: number;
    readonly target: 'gates' | 'activatedPlatform';
  };
  readonly activatedPlatform: {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly element: ElementalRole | 'neutral';
    readonly hazardId?: string;
  };
}

export type ElementalLevel =
  ElementalLevelBase | (ElementalLevelBase & { readonly mechanics: ElementalMechanics });

export type ElementalRamp = NonNullable<ElementalLevelBase['ramps']>[number];

/** Returns the walkable surface height at a world X coordinate inside a ramp. */
export function elementalRampSurfaceY(ramp: ElementalRamp, worldX: number): number {
  const progress = Math.max(0, Math.min(1, (worldX - ramp.x) / ramp.width));
  return ramp.y + (ramp.direction === 'up-right' ? progress : 1 - progress) * ramp.height;
}

export const ELEMENTAL_SPLITROOT_TEMPLE_LEVEL = {
  number: 1,
  id: 'splitroot-temple-01',
  name: 'Splitroot Temple',
  chapter: 'Level 1',
  width: 86,
  playerWidth: 1.6,
  moveSpeed: 8.4,
  jumpSpeed: 13,
  gravity: -24,
  spawns: {
    ember: 40.5,
    tide: 44,
  },
  spawnY: {
    ember: 0,
    tide: 0,
  },
  gates: {
    ember: {
      x: 1,
      y: 0,
      width: 2.7,
    },
    tide: {
      x: 82.3,
      y: 0,
      width: 2.7,
    },
  },
  solids: [],
  platforms: [
    {
      id: 'right-upper-root-copy-mum44v0c-1',
      x: 36,
      y: 8,
      width: 6,
      element: 'ember',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1',
      x: 26,
      y: 6,
      width: 6,
      element: 'ember',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1-copy-mum45nea-2',
      x: 16,
      y: 4,
      width: 6,
      element: 'ember',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1-copy-mum45nea-2-copy-mum45qak-2',
      x: 6,
      y: 2,
      width: 6,
      element: 'ember',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1-copy-mum45nea-2-copy-mum45qak-2-copy-mum4rsgw-1',
      x: 74,
      y: 2,
      width: 6,
      element: 'tide',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1-copy-mum45nea-2-copy-mum4rsgw-4',
      x: 64,
      y: 4,
      width: 6,
      element: 'tide',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum45fue-1-copy-mum4rsgw-5',
      x: 54,
      y: 6,
      width: 6,
      element: 'tide',
    },
    {
      id: 'right-upper-root-copy-mum44v0c-1-copy-mum4rsgw-7',
      x: 44,
      y: 8,
      width: 6,
      element: 'tide',
    },
  ],
  hazards: [
    {
      id: 'left-deep-pool',
      x: 27.45,
      width: 3.1,
      safeRole: 'tide',
    },
    {
      id: 'left-temple-fire',
      x: 34.6,
      width: 2.8,
      safeRole: 'none',
    },
    {
      id: 'left-deep-pool-copy-mum4v9nr-1',
      x: 13.5,
      width: 3.1,
      safeRole: 'tide',
    },
    {
      id: 'left-temple-fire-copy-mum4v9nr-2',
      x: 20.5,
      width: 2.8,
      safeRole: 'ember',
    },
    {
      id: 'left-temple-fire-copy-mum4v9nr-2-copy-mum4wgad-1',
      x: 6.5,
      width: 2.8,
      safeRole: 'ember',
    },
    {
      id: 'left-temple-fire-copy-mum4v9nr-2-copy-mum4wgad-1-copy-mum4xb1j-1',
      x: 76.7,
      width: 2.8,
      safeRole: 'tide',
    },
    {
      id: 'left-deep-pool-copy-mum4v9nr-1-copy-mum4xb1j-2',
      x: 69.4,
      width: 3.1,
      safeRole: 'ember',
    },
    {
      id: 'left-temple-fire-copy-mum4v9nr-2-copy-mum4xb1j-3',
      x: 62.7,
      width: 2.8,
      safeRole: 'tide',
    },
    {
      id: 'left-deep-pool-copy-mum4xb1j-4',
      x: 55.45,
      width: 3.1,
      safeRole: 'ember',
    },
    {
      id: 'left-temple-fire-copy-mum4xb1j-5',
      x: 48.6,
      width: 2.8,
      safeRole: 'none',
    },
  ],
  crystals: [
    {
      id: 'ember-shard-low',
      x: 29,
      y: 7.5,
      role: 'ember',
    },
    {
      id: 'ember-shard-high',
      x: 39,
      y: 9.5,
      role: 'ember',
    },
    {
      id: 'ember-shard-low-copy-mum45nea-1',
      x: 19,
      y: 5.5,
      role: 'ember',
    },
    {
      id: 'ember-shard-low-copy-mum45nea-1-copy-mum45qak-1',
      x: 9,
      y: 3.5,
      role: 'ember',
    },
    {
      id: 'ember-shard-low-copy-mum45nea-1-copy-mum45qak-1-copy-mum4rsgw-2',
      x: 77,
      y: 3.5,
      role: 'tide',
    },
    {
      id: 'ember-shard-low-copy-mum45nea-1-copy-mum4rsgw-3',
      x: 67,
      y: 5.5,
      role: 'tide',
    },
    {
      id: 'ember-shard-low-copy-mum4rsgw-6',
      x: 57,
      y: 7.5,
      role: 'tide',
    },
    {
      id: 'ember-shard-high-copy-mum4rsgw-8',
      x: 47,
      y: 9.5,
      role: 'tide',
    },
  ],
  requiredCrystals: {
    ember: 4,
    tide: 4,
  },
  environmentZones: [
    {
      id: 'splitroot-outside',
      x: 0,
      y: 0,
      width: 86,
      height: 17.2,
      environment: 'outside',
    },
  ],
  entrances: [],
} as const satisfies ElementalLevel;

// Compatibility alias for existing clients and game-server imports.
export const ELEMENTAL_GROVE_LEVEL = ELEMENTAL_SPLITROOT_TEMPLE_LEVEL;

export const ELEMENTAL_FOUNDRY_LEVEL = {
  number: 2,
  id: 'crosscurrent-vault-02',
  name: 'Crosscurrent Vault',
  chapter: 'Level 2',
  width: 64,
  playerWidth: 1.6,
  moveSpeed: 8.6,
  jumpSpeed: 13,
  gravity: -24,
  spawns: {
    ember: 1.5,
    tide: 4,
  },
  spawnY: {
    ember: 0,
    tide: 0,
  },
  gates: {
    ember: {
      x: 29,
      y: 0,
      width: 2.7,
    },
    tide: {
      x: 32.5,
      y: 0,
      width: 2.7,
    },
  },
  solids: [],
  platforms: [],
  hazards: [
    {
      id: 'lever-chasm',
      x: 42.5,
      width: 10,
      safeRole: 'none',
    },
  ],
  crystals: [],
  requiredCrystals: {
    ember: 0,
    tide: 0,
  },
  environmentZones: [],
  entrances: [],
  mechanics: {
    pressurePlate: {
      id: 'vault-floor-plate',
      x: 12.5,
      y: 0,
      width: 3.2,
      target: 'activatedPlatform',
    },
    lever: {
      id: 'vault-bridge-lever',
      x: 59,
      y: 0,
      width: 3.2,
      reach: 1.6,
      target: 'gates',
    },
    activatedPlatform: {
      id: 'vault-bridge',
      x: 42.5,
      y: 0,
      width: 10,
      element: 'neutral',
      hazardId: 'lever-chasm',
    },
    pushable: {
      id: 'pushable-muno687f',
      x: 22.5,
      y: 0,
      width: 2,
      height: 2,
      pushSpeed: 5,
    },
  },
  ramps: [],
} as const satisfies ElementalLevel;

export const ELEMENTAL_DUNGEON_LEVEL = {
  number: 3,
  id: 'sundered-keep-03',
  name: 'Sundered Keep',
  chapter: 'Level 3',
  width: 82,
  playerWidth: 1.6,
  moveSpeed: 8.6,
  jumpSpeed: 13,
  gravity: -24,
  spawns: {
    ember: 4,
    tide: 8,
  },
  spawnY: {
    ember: 15,
    tide: 15,
  },
  gates: {
    ember: {
      x: 18.3,
      y: 0,
      width: 2.7,
    },
    tide: {
      x: 78.3,
      y: 0,
      width: 2.7,
    },
  },
  solids: [
    {
      id: 'outside-approach',
      x: 0,
      y: 0,
      width: 18,
      height: 15,
    },
    {
      id: 'dungeon-roof',
      x: 18,
      y: 17.2,
      width: 64,
      height: 4.8,
    },
    {
      id: 'upper-floor-left',
      x: 18,
      y: 11.8,
      width: 18,
      height: 0.8,
    },
    {
      id: 'upper-floor-right',
      x: 42,
      y: 11.8,
      width: 40,
      height: 0.8,
    },
    {
      id: 'middle-floor-left',
      x: 18,
      y: 7.5,
      width: 35,
      height: 0.8,
    },
    {
      id: 'middle-floor-right',
      x: 59,
      y: 7.5,
      width: 23,
      height: 0.8,
    },
    {
      id: 'lower-floor-left',
      x: 23,
      y: 3.2,
      width: 7,
      height: 0.8,
    },
    {
      id: 'lower-floor-right',
      x: 36,
      y: 3.2,
      width: 38,
      height: 0.8,
    },
  ],
  platforms: [
    {
      id: 'entrance-step',
      x: 16.8,
      y: 13.2,
      width: 5.2,
      element: 'neutral',
    },
    {
      id: 'upper-shaft-step',
      x: 36.5,
      y: 10.2,
      width: 5,
      element: 'neutral',
    },
    {
      id: 'middle-shaft-step',
      x: 53.5,
      y: 5.8,
      width: 5,
      element: 'neutral',
    },
    {
      id: 'tunnel-chasm-step',
      x: 39.2,
      y: 1.45,
      width: 3.8,
      element: 'neutral',
    },
  ],
  hazards: [
    {
      id: 'ember-tunnel-fire',
      x: 25.3,
      width: 2.2,
      safeRole: 'ember',
    },
    {
      id: 'tunnel-chasm',
      x: 39.8,
      width: 2.4,
      safeRole: 'none',
    },
    {
      id: 'tide-tunnel-water',
      x: 66.5,
      width: 2.2,
      safeRole: 'tide',
    },
  ],
  crystals: [
    {
      id: 'ember-upper-shard',
      x: 27,
      y: 13.85,
      role: 'ember',
    },
    {
      id: 'ember-middle-shard',
      x: 66,
      y: 9.55,
      role: 'ember',
    },
    {
      id: 'ember-tunnel-shard',
      x: 61,
      y: 1.25,
      role: 'ember',
    },
    {
      id: 'tide-upper-shard',
      x: 49,
      y: 13.85,
      role: 'tide',
    },
    {
      id: 'tide-middle-shard',
      x: 25,
      y: 9.55,
      role: 'tide',
    },
    {
      id: 'tide-tunnel-shard',
      x: 22.5,
      y: 1.25,
      role: 'tide',
    },
  ],
  requiredCrystals: {
    ember: 3,
    tide: 3,
  },
  environmentZones: [
    {
      id: 'keep-exterior',
      x: 0,
      y: 0,
      width: 18,
      height: 17.2,
      environment: 'outside',
    },
    {
      id: 'keep-underground',
      x: 18,
      y: 0,
      width: 64,
      height: 17.2,
      environment: 'underground',
    },
  ],
  entrances: [
    {
      id: 'keep-descent',
      x: 16.8,
      y: 11.8,
      width: 5.2,
      height: 5.4,
      from: 'outside',
      to: 'underground',
    },
  ],
} as const satisfies ElementalLevel;

export const ELEMENTAL_AUTHORED_LEVELS: readonly ElementalLevel[] =
  ELEMENTAL_PUBLISHED_LEVELS.length > 0
    ? ELEMENTAL_PUBLISHED_LEVELS
    : [ELEMENTAL_GROVE_LEVEL, ELEMENTAL_FOUNDRY_LEVEL, ELEMENTAL_DUNGEON_LEVEL];

export const ELEMENTAL_PLATFORMER_TICKS_PER_SECOND = 30;

function canonicalLevelValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLevelValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalLevelValue(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function levelFingerprint(value: unknown): string {
  const source = canonicalLevelValue(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Changes whenever a level's geometry, mechanics, or other authored rule changes. */
export function elementalLevelFingerprint(level: ElementalLevel): string {
  return levelFingerprint(level);
}

/** A change to any level invalidates all records from the previous level set. */
export function elementalCatalogFingerprint(
  levels: readonly ElementalLevel[] = ELEMENTAL_AUTHORED_LEVELS,
): string {
  return levelFingerprint(levels);
}

export function elementalLevel(levelNumber: number): ElementalLevel {
  return ELEMENTAL_AUTHORED_LEVELS[levelNumber - 1] ?? ELEMENTAL_AUTHORED_LEVELS[0]!;
}

/** Bitmask with one bit per authored crystal; shared by server state and clients. */
export const ELEMENTAL_ALL_CRYSTALS_MASK = (1 << ELEMENTAL_GROVE_LEVEL.crystals.length) - 1;

export function elementalCrystalMaskForRole(
  role: ElementalRole,
  level: Pick<ElementalLevel, 'crystals'> = ELEMENTAL_GROVE_LEVEL,
): number {
  return level.crystals.reduce(
    (mask, crystal, index) => (crystal.role === role ? mask | (1 << index) : mask),
    0,
  );
}

/** Gate eligibility uses each role's authored quota, not every placed crystal. */
export function elementalRoleHasRequiredCrystals(
  role: ElementalRole,
  collectedMask: number,
  level: ElementalLevel = ELEMENTAL_GROVE_LEVEL,
): boolean {
  const roleMask = elementalCrystalMaskForRole(role, level);
  return countCollectedElementalCrystals(collectedMask & roleMask) >= level.requiredCrystals[role];
}

export const ELEMENTAL_EMBER_CRYSTALS_MASK = elementalCrystalMaskForRole('ember');
export const ELEMENTAL_TIDE_CRYSTALS_MASK = elementalCrystalMaskForRole('tide');

export function countCollectedElementalCrystals(mask: number): number {
  let remaining = mask & 0xffff;
  let count = 0;
  while (remaining !== 0) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
}

/** Immutable role ownership stored with an elemental-platformer game session. */
export interface ElementalRoleAssignment {
  readonly creator: AccountId;
  readonly creatorRole: ElementalRole;
  readonly ember: AccountId;
  readonly tide: AccountId;
}

export function oppositeElementalRole(role: ElementalRole): ElementalRole {
  return role === 'ember' ? 'tide' : 'ember';
}

/**
 * The creator chooses once. The linked partner receives the other role, and
 * callers persist this returned assignment rather than deriving it again.
 */
export function assignElementalRoles(
  creator: AccountId,
  linkedPartner: AccountId,
  creatorRole: ElementalRole,
): ElementalRoleAssignment {
  return creatorRole === 'ember'
    ? { creator, creatorRole, ember: creator, tide: linkedPartner }
    : { creator, creatorRole, ember: linkedPartner, tide: creator };
}

export function elementalRoleFor(
  assignment: ElementalRoleAssignment,
  account: AccountId,
): ElementalRole | null {
  if (assignment.ember === account) return 'ember';
  if (assignment.tide === account) return 'tide';
  return null;
}
