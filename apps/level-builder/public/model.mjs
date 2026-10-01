export const ROLES = ['ember', 'tide'];
export const TOOLS = [
  'select',
  'platform',
  'ramp',
  'solid',
  'hazard',
  'crystal',
  'gate',
  'spawn',
  'lever',
  'pressurePlate',
  'pushable',
  'activatedPlatform',
  'environmentZone',
  'entrance',
  'resize',
];
export const CAMERA_MIN_ZOOM = 0.05;

export function cloneLevel(level) {
  const cloned = JSON.parse(JSON.stringify(level));
  cloned.number = Number.isInteger(Number(cloned.number)) ? Number(cloned.number) : 1;
  delete cloned.order;
  cloned.chapter ||= `Level ${cloned.number}`;
  cloned.ramps ??= [];
  if (Array.isArray(cloned.crystals)) {
    cloned.requiredCrystals = {
      ember:
        cloned.requiredCrystals?.ember ??
        cloned.crystals.filter((crystal) => crystal.role === 'ember').length,
      tide:
        cloned.requiredCrystals?.tide ??
        cloned.crystals.filter((crystal) => crystal.role === 'tide').length,
    };
  }
  if (cloned.mechanics?.pushable) {
    delete cloned.mechanics.pushable.minX;
    delete cloned.mechanics.pushable.maxX;
  }
  return cloned;
}

const cleanCoordinate = (value) => Number(value.toFixed(6));

/** Reflects one runtime-format object across the stage's center axis. */
export function mirrorObjectAcrossStage(levelWidth, kind, object) {
  const mirrored = cloneLevel(object);
  mirrored.x = cleanCoordinate(
    kind === 'crystal' ? levelWidth - object.x : levelWidth - object.x - (object.width ?? 0),
  );
  if (kind === 'ramp')
    mirrored.direction = object.direction === 'up-right' ? 'up-left' : 'up-right';
  return mirrored;
}

export function blankLevel(number = 4) {
  return {
    number,
    id: `new-level-${String(number).padStart(2, '0')}`,
    name: 'Untitled Level',
    chapter: `Level ${number}`,
    width: 64,
    playerWidth: 1.6,
    moveSpeed: 8.6,
    jumpSpeed: 13,
    gravity: -24,
    spawns: { ember: 5, tide: 9 },
    spawnY: { ember: 0, tide: 0 },
    gates: { ember: { x: 1, y: 0, width: 2.7 }, tide: { x: 60.3, y: 0, width: 2.7 } },
    solids: [],
    platforms: [],
    ramps: [],
    hazards: [],
    crystals: [],
    requiredCrystals: { ember: 1, tide: 1 },
    environmentZones: [
      { id: 'outside-zone', x: 0, y: 0, width: 64, height: 17.2, environment: 'outside' },
    ],
    entrances: [],
  };
}

function collectionName(kind) {
  if (kind === 'solid') return 'solids';
  if (kind === 'environmentZone') return 'environmentZones';
  return `${kind}s`;
}

export function allObjects(level) {
  const mechanics = level.mechanics ?? {};
  return [
    ...level.solids.map((item) => ({ ...item, kind: 'solid' })),
    ...level.platforms.map((item) => ({ ...item, kind: 'platform' })),
    ...(level.ramps ?? []).map((item) => ({ ...item, kind: 'ramp' })),
    ...level.hazards.map((item) => ({ ...item, kind: 'hazard', y: 0 })),
    ...level.crystals.map((item) => ({ ...item, kind: 'crystal', width: 1.2 })),
    ...(level.environmentZones ?? []).map((item) => ({ ...item, kind: 'environmentZone' })),
    ...(level.entrances ?? []).map((item) => ({ ...item, kind: 'entrance' })),
    ...ROLES.map((role) => ({ ...level.gates[role], id: `${role}-gate`, kind: 'gate', role })),
    ...ROLES.map((role) => ({
      id: `${role}-spawn`,
      kind: 'spawn',
      role,
      x: level.spawns[role],
      y: level.spawnY[role],
      width: level.playerWidth,
    })),
    ...(mechanics.lever ? [{ ...mechanics.lever, kind: 'lever' }] : []),
    ...(mechanics.pressurePlate ? [{ ...mechanics.pressurePlate, kind: 'pressurePlate' }] : []),
    ...(mechanics.pushable ? [{ ...mechanics.pushable, kind: 'pushable' }] : []),
    ...(mechanics.activatedPlatform
      ? [{ ...mechanics.activatedPlatform, kind: 'activatedPlatform' }]
      : []),
  ];
}

export function findObject(level, ref) {
  if (!ref) return null;
  if (ref.kind === 'gate') return level.gates[ref.role];
  if (ref.kind === 'spawn') return { x: level.spawns[ref.role], y: level.spawnY[ref.role] };
  if (['lever', 'pressurePlate', 'pushable', 'activatedPlatform'].includes(ref.kind))
    return level.mechanics?.[ref.kind] ?? null;
  const collection = collectionName(ref.kind);
  return level[collection]?.find((item) => item.id === ref.id) ?? null;
}

export function updateObject(level, ref, patch) {
  if (ref.kind === 'gate') Object.assign(level.gates[ref.role], patch);
  else if (ref.kind === 'spawn') {
    if (patch.x !== undefined) level.spawns[ref.role] = patch.x;
    if (patch.y !== undefined) level.spawnY[ref.role] = patch.y;
  } else Object.assign(findObject(level, ref), patch);
}

export function removeObject(level, ref) {
  if (!ref || ref.kind === 'gate' || ref.kind === 'spawn') return false;
  if (['lever', 'pressurePlate', 'pushable', 'activatedPlatform'].includes(ref.kind)) {
    if (!level.mechanics?.[ref.kind]) return false;
    delete level.mechanics[ref.kind];
    if (!Object.keys(level.mechanics).length) delete level.mechanics;
    return true;
  }
  const collection = collectionName(ref.kind);
  level[collection] = level[collection].filter((item) => item.id !== ref.id);
  return true;
}

export function createObject(level, kind, x, y, role = 'neutral') {
  const id = `${kind}-${Date.now().toString(36)}`;
  if (kind === 'platform') level.platforms.push({ id, x, y, width: 5, element: role });
  if (kind === 'ramp')
    (level.ramps ??= []).push({
      id,
      x,
      y,
      width: 6,
      height: 3,
      direction: 'up-right',
      element: role,
    });
  if (kind === 'solid') level.solids.push({ id, x, y, width: 6, height: 1 });
  if (kind === 'hazard')
    level.hazards.push({ id, x, width: 3, safeRole: role === 'neutral' ? 'none' : role });
  if (kind === 'crystal')
    level.crystals.push({ id, x, y, role: role === 'tide' ? 'tide' : 'ember' });
  if (kind === 'environmentZone') {
    level.environmentZones ??= [];
    level.environmentZones.push({
      id,
      x,
      y,
      width: 12,
      height: 8,
      environment: 'underground',
    });
  }
  if (kind === 'entrance') {
    level.entrances ??= [];
    level.entrances.push({
      id,
      x,
      y,
      width: 3.5,
      height: 4.5,
      from: 'outside',
      to: 'underground',
    });
  }
  if (['lever', 'pressurePlate', 'pushable', 'activatedPlatform'].includes(kind)) {
    level.mechanics ??= {};
    if (kind === 'lever')
      level.mechanics.lever = {
        id,
        x,
        y,
        width: 3.2,
        reach: 1.6,
        target: 'activatedPlatform',
      };
    if (kind === 'pressurePlate')
      level.mechanics.pressurePlate = {
        id,
        x,
        y,
        width: 3.2,
        target: 'activatedPlatform',
      };
    if (kind === 'pushable')
      level.mechanics.pushable = {
        id,
        x,
        y,
        width: 2,
        height: 2,
        pushSpeed: 6,
      };
    if (kind === 'activatedPlatform')
      level.mechanics.activatedPlatform = {
        id,
        x,
        y,
        width: 8,
        element: role,
      };
  }
  return { kind, id };
}

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x;
const issue = (severity, code, message, ids = []) => ({ severity, code, message, ids });

export function validateLevel(level) {
  const issues = [];
  const objects = allObjects(level);
  if (!Number.isInteger(level.number) || level.number < 1)
    issues.push(issue('error', 'level-number', 'Level number must be a positive whole number.'));
  if (!Number.isFinite(level.width) || level.width < 20)
    issues.push(issue('error', 'world-width', 'World width must be at least 20 units.'));
  for (const object of objects) {
    if (object.x < 0 || object.x + (object.width ?? 0) > level.width)
      issues.push(
        issue('error', 'out-of-bounds', `${object.id} extends outside the world.`, [object.id]),
      );
    if ((object.y ?? 0) < 0 || (object.height && object.y + object.height > 17.2))
      issues.push(
        issue(
          'warning',
          'vertical-range',
          `${object.id} is outside the tested y=0…17.2 camera range.`,
          [object.id],
        ),
      );
  }
  const shardCounts = Object.fromEntries(
    ROLES.map((role) => [role, level.crystals.filter((crystal) => crystal.role === role).length]),
  );
  for (const role of ROLES) {
    const count = shardCounts[role];
    const required = level.requiredCrystals?.[role];
    if (!Number.isInteger(required) || required < 0 || required > count)
      issues.push(
        issue(
          'error',
          'shard-requirement',
          `${role} requires a whole number from 0 to ${count}; found ${required ?? 'unset'}.`,
        ),
      );
    const spawn = { x: level.spawns[role] - level.playerWidth / 2, width: level.playerWidth };
    for (const hazard of level.hazards)
      if (hazard.safeRole !== role && overlaps(spawn, hazard))
        issues.push(
          issue('error', 'unsafe-spawn', `${role} spawns in lethal hazard ${hazard.id}.`, [
            hazard.id,
            `${role}-spawn`,
          ]),
        );
  }
  if (level.crystals.length > 16)
    issues.push(
      issue('error', 'shard-mask', 'The uint16 protocol supports no more than 16 total shards.'),
    );
  if (level.mechanics) {
    for (const kind of ['lever', 'pressurePlate', 'pushable', 'activatedPlatform']) {
      if (!level.mechanics[kind])
        issues.push(
          issue(
            'error',
            'mechanic-set',
            `Mechanic levels need a ${kind}; add it or remove the other mechanic objects.`,
          ),
        );
    }
    for (const control of [level.mechanics.lever, level.mechanics.pressurePlate].filter(Boolean)) {
      if (!['gates', 'activatedPlatform'].includes(control.target))
        issues.push(
          issue('error', 'control-target', `${control.id} needs a valid controlled target.`, [
            control.id,
          ]),
        );
    }
  }
  const zones = level.environmentZones ?? [];
  const entrances = level.entrances ?? [];
  const hasOutside = zones.some((zone) => zone.environment === 'outside');
  const hasUnderground = zones.some((zone) => zone.environment === 'underground');
  if (hasOutside && hasUnderground) {
    const hasValidTransition = entrances.some(
      (entrance) =>
        (entrance.from === 'outside' && entrance.to === 'underground') ||
        (entrance.from === 'underground' && entrance.to === 'outside'),
    );
    if (!hasValidTransition)
      issues.push(
        issue(
          'error',
          'missing-underground-transition',
          'Mixed outside/underground levels need an authored entrance or exit between them.',
        ),
      );
  }
  if (!hasOutside && entrances.some((entrance) => entrance.from === 'outside'))
    issues.push(
      issue(
        'error',
        'orphan-outside-entrance',
        'An all-underground level cannot begin with an entrance from outside.',
      ),
    );
  for (const entrance of entrances) {
    if (entrance.from === entrance.to)
      issues.push(
        issue(
          'error',
          'invalid-environment-transition',
          `${entrance.id} must connect different environments.`,
          [entrance.id],
        ),
      );
  }
  for (const platform of level.platforms) {
    if (platform.width < 3.2)
      issues.push(
        issue(
          'warning',
          'landing-width',
          `${platform.id} is narrower than the 3.2-unit required landing minimum.`,
          [platform.id],
        ),
      );
    if (platform.y <= 4.7)
      for (const hazard of level.hazards)
        if (overlaps(platform, hazard))
          issues.push(
            issue('error', 'pool-overlap', `${platform.id} covers pool ${hazard.id}.`, [
              platform.id,
              hazard.id,
            ]),
          );
  }
  for (const ramp of level.ramps ?? []) {
    if (ramp.width <= 0 || ramp.height <= 0)
      issues.push(
        issue('error', 'ramp-size', `${ramp.id} needs positive width and height.`, [ramp.id]),
      );
    if (!['up-left', 'up-right'].includes(ramp.direction))
      issues.push(
        issue('error', 'ramp-direction', `${ramp.id} needs a valid rise direction.`, [ramp.id]),
      );
    if (ramp.height / Math.max(ramp.width, 0.01) > 0.8)
      issues.push(
        issue(
          'warning',
          'ramp-steepness',
          `${ramp.id} is very steep; keep rise/run at or below 0.8 for reliable traversal.`,
          [ramp.id],
        ),
      );
  }
  for (const role of ROLES) {
    const gate = level.gates[role];
    const envelope = { x: gate.x - 1.15, width: gate.width + 2.3 };
    for (const object of [...level.platforms, ...level.solids, ...(level.ramps ?? [])])
      if (overlaps(envelope, object) && object.y < gate.y + 5)
        issues.push(
          issue(
            'error',
            'gate-overlap',
            `${object.id} intersects the ${role} gate visual envelope.`,
            [object.id, `${role}-gate`],
          ),
        );
  }
  const surfaces = [
    ...level.platforms,
    ...level.solids.map((solid) => ({ ...solid, y: solid.y + solid.height })),
  ].sort((a, b) => a.x - b.x);
  for (let index = 1; index < surfaces.length; index += 1) {
    const before = surfaces[index - 1];
    const after = surfaces[index];
    if (after.y - before.y > 3.2 && after.x <= before.x + before.width + 6)
      issues.push(
        issue(
          'warning',
          'rise-limit',
          `${before.id} → ${after.id} rises ${(after.y - before.y).toFixed(1)} units (max 3.2).`,
          [before.id, after.id],
        ),
      );
  }
  const ids = objects.map((object) => object.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length)
    issues.push(
      issue('error', 'duplicate-id', `Duplicate IDs: ${[...new Set(repeated)].join(', ')}.`),
    );
  if (!issues.length)
    issues.push(
      issue(
        'pass',
        'geometry-pass',
        'Automated geometry checks pass. Complete the two-player route proof and device playtest before shipping.',
      ),
    );
  else
    issues.push(
      issue(
        'info',
        'manual-proof',
        'Automated checks cannot prove route reachability. Complete the traversal proof and two-client playtest.',
      ),
    );
  return issues;
}

export function exportJson(level) {
  return `${JSON.stringify(level, null, 2)}\n`;
}
export function exportTypescript(level) {
  const constant = `ELEMENTAL_${level.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_LEVEL`;
  return `export const ${constant} = ${JSON.stringify(level, null, 2)} as const;\n`;
}

/** Reads the JSON-shaped TypeScript emitted by exportTypescript without executing source code. */
export function importTypescriptLevel(source) {
  const match = source
    .trim()
    .match(/^export\s+const\s+[A-Za-z_$][\w$]*\s*=\s*([\s\S]*?)\s+as\s+const\s*;?\s*$/);
  if (!match) {
    throw new Error('Expected an exported level constant ending in `as const`.');
  }
  return JSON.parse(match[1]);
}

export function createPlaytestPlayer(level, role) {
  return {
    x: level.spawns[role],
    y: level.spawnY[role],
    velocityX: 0,
    velocityY: 0,
    grounded: true,
  };
}

export function createPlaytestMechanicState(level) {
  if (!level.mechanics) return null;
  return {
    leverActivated: false,
    pressurePlatePressed: false,
    pushableX: level.mechanics.pushable?.x ?? null,
  };
}

export function playtestActivatedPlatformIsActive(level, mechanicState) {
  const mechanics = level.mechanics;
  if (!mechanics?.activatedPlatform || !mechanicState) return false;
  const leverControls = mechanics.lever?.target === 'activatedPlatform';
  const plateControls = mechanics.pressurePlate?.target === 'activatedPlatform';
  return (
    (leverControls || plateControls) &&
    (!leverControls || mechanicState.leverActivated) &&
    (!plateControls || mechanicState.pressurePlatePressed)
  );
}

export function rampSurfaceY(ramp, worldX) {
  const progress = Math.max(0, Math.min(1, (worldX - ramp.x) / ramp.width));
  return ramp.y + (ramp.direction === 'up-right' ? progress : 1 - progress) * ramp.height;
}

export function pushableSupportY(level, pushableX) {
  const pushable = level.mechanics?.pushable;
  if (!pushable || !Number.isFinite(pushableX)) return 0;
  const centerX = pushableX + pushable.width / 2;
  const ramp = (level.ramps ?? []).find(
    (candidate) => centerX >= candidate.x - 1e-6 && centerX <= candidate.x + candidate.width + 1e-6,
  );
  if (ramp) return rampSurfaceY(ramp, centerX);
  for (const candidate of level.ramps ?? []) {
    const highX = candidate.direction === 'up-right' ? candidate.x + candidate.width : candidate.x;
    const highY = candidate.y + candidate.height;
    const surfaces = [
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
    const support = surfaces.find((surface) => {
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
  return pushable.y;
}

export function resolvePushableX(
  level,
  pushableX,
  proposedX,
  allowRampTraversal = false,
  activatedPlatformActive = false,
) {
  const pushable = level.mechanics?.pushable;
  if (!pushable) return pushableX;
  let resolved = Math.max(0, Math.min(level.width - pushable.width, proposedX));
  const currentCenter = pushableX + pushable.width / 2;
  const proposedCenter = resolved + pushable.width / 2;
  const touchesRamp = (level.ramps ?? []).some(
    (ramp) =>
      (currentCenter >= ramp.x && currentCenter <= ramp.x + ramp.width) ||
      (proposedCenter >= ramp.x && proposedCenter <= ramp.x + ramp.width),
  );
  if (touchesRamp && !allowRampTraversal) return pushableX;
  for (const ramp of level.ramps ?? []) {
    const highEdge = ramp.direction === 'up-right' ? ramp.x + ramp.width : ramp.x;
    const crossedHighEdge =
      ramp.direction === 'up-right'
        ? currentCenter <= highEdge + 1e-6 && proposedCenter > highEdge
        : currentCenter >= highEdge - 1e-6 && proposedCenter < highEdge;
    if (!crossedHighEdge) continue;
    const beyondCenter = highEdge + (ramp.direction === 'up-right' ? 0.01 : -0.01);
    const upperSupport = pushableSupportY(level, beyondCenter - pushable.width / 2);
    if (upperSupport < ramp.y + ramp.height - 0.15)
      resolved = highEdge - pushable.width / 2;
  }
  const pushableY = pushableSupportY(level, resolved);
  const platforms =
    activatedPlatformActive && level.mechanics.activatedPlatform
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
  ].filter(
    (blocker) => pushableY < blocker.y + blocker.height && pushableY + pushable.height > blocker.y,
  );
  if (resolved > pushableX)
    for (const blocker of blockers) {
      if (pushableX + pushable.width <= blocker.x && resolved + pushable.width > blocker.x)
        resolved = Math.min(resolved, blocker.x - pushable.width);
    }
  else if (resolved < pushableX)
    for (const blocker of blockers) {
      const edge = blocker.x + blocker.width;
      if (pushableX >= edge && resolved < edge) resolved = Math.max(resolved, edge);
    }
  return resolved;
}

/** Snaps a jump test to a nearby edge or the highest usable surface directly below. */
export function snapJumpOrigin(level, position, role, edgeThreshold = 1.25) {
  const surfaces = [
    { x: 0, y: 0, width: level.width, kind: 'ground' },
    ...level.solids.map((solid) => ({ x: solid.x, y: solid.y + solid.height, width: solid.width })),
    ...level.platforms
      .filter((platform) => platform.element === 'neutral' || platform.element === role)
      .map((platform) => ({ x: platform.x, y: platform.y, width: platform.width })),
    ...(level.ramps ?? [])
      .filter((ramp) => ramp.element === 'neutral' || ramp.element === role)
      .map((ramp) => ({
        x: ramp.x,
        y: rampSurfaceY(ramp, Math.max(ramp.x, Math.min(ramp.x + ramp.width, position.x))),
        width: ramp.width,
      })),
    ...(level.mechanics?.pushable
      ? [
          {
            x: level.mechanics.pushable.x,
            y:
              pushableSupportY(level, level.mechanics.pushable.x) +
              level.mechanics.pushable.height,
            width: level.mechanics.pushable.width,
          },
        ]
      : []),
  ];
  const freeOrigin = {
    x: Math.max(0, Math.min(level.width - level.playerWidth, position.x - level.playerWidth / 2)),
    y: Math.max(0, position.y),
    snappedEdge: false,
    snappedSurface: false,
    edgeX: null,
  };
  if (edgeThreshold < 0) return freeOrigin;

  const candidates = [];
  for (const surface of surfaces) {
    if (Math.abs(position.y - surface.y) > edgeThreshold) continue;
    for (const side of ['left', 'right']) {
      const edgeX = side === 'left' ? surface.x : surface.x + surface.width;
      const distance = Math.hypot(position.x - edgeX, position.y - surface.y);
      if (distance <= edgeThreshold) candidates.push({ surface, side, edgeX, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const match = candidates[0];
  if (match)
    return {
      x: Math.max(
        0,
        Math.min(
          level.width - level.playerWidth,
          match.side === 'left'
            ? match.surface.x
            : match.surface.x + match.surface.width - level.playerWidth,
        ),
      ),
      y: match.surface.y,
      snappedEdge: true,
      snappedSurface: true,
      edgeX: match.edgeX,
    };

  const surfaceBelow = surfaces
    .filter(
      (surface) =>
        surface.y <= position.y &&
        position.x >= surface.x &&
        position.x <= surface.x + surface.width,
    )
    .sort((a, b) => b.y - a.y)[0];
  if (!surfaceBelow) return freeOrigin;
  const maximumX = surfaceBelow.x + surfaceBelow.width - level.playerWidth;
  return {
    x: Math.max(surfaceBelow.x, Math.min(maximumX, freeOrigin.x)),
    y: surfaceBelow.y,
    snappedEdge: false,
    snappedSurface: true,
    edgeX: null,
  };
}

/** Resizes a rectangle from one edge/corner while keeping the opposite side fixed. */
export function resizeRectangle(bounds, handle, delta, grid = 0.5, minimum = 0.5) {
  const snapValue = (value) => cleanCoordinate(Math.round(value / grid) * grid);
  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y;
  let top = bounds.y + bounds.height;
  if (handle.includes('w')) left = Math.min(snapValue(left + delta.x), right - minimum);
  if (handle.includes('e')) right = Math.max(snapValue(right + delta.x), left + minimum);
  if (handle.includes('s')) bottom = Math.min(snapValue(bottom + delta.y), top - minimum);
  if (handle.includes('n')) top = Math.max(snapValue(top + delta.y), bottom + minimum);
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

function overlapsHorizontally(player, object, playerWidth) {
  return player.x + playerWidth > object.x && player.x < object.x + object.width;
}

/** Browser playtest physics mirrors the authoritative server's solid/platform rules. */
export function stepPlaytestPlayer(
  level,
  player,
  input,
  role,
  elapsedSeconds,
  mechanicState = null,
) {
  const dt = Math.max(0, Math.min(elapsedSeconds, 1 / 30));
  const subSteps = 3;
  const subDt = dt / subSteps;
  const moveX = input.moveX === -1 || input.moveX === 1 ? input.moveX : 0;
  player.velocityX = moveX * level.moveSpeed;
  if (input.jump && player.grounded) {
    player.velocityY = level.jumpSpeed;
    player.grounded = false;
  }

  for (let index = 0; index < subSteps; index += 1) {
    player.velocityY += level.gravity * subDt;
    const previousX = player.x;
    const previousY = player.y;
    player.x = Math.max(
      0,
      Math.min(level.width - level.playerWidth, player.x + player.velocityX * subDt),
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

    player.y += player.velocityY * subDt;
    if (previousY > 0) player.grounded = false;
    const solidLanding = level.solids.find(
      (solid) =>
        player.velocityY <= 0 &&
        previousY >= solid.y + solid.height &&
        player.y <= solid.y + solid.height &&
        overlapsHorizontally(player, solid, level.playerWidth),
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
        overlapsHorizontally(player, solid, level.playerWidth),
    );
    if (solidCeiling) {
      player.y = solidCeiling.y - level.playerWidth;
      player.velocityY = 0;
    }
    const activatedPlatformActive = playtestActivatedPlatformIsActive(level, mechanicState);
    const platforms = activatedPlatformActive
      ? [...level.platforms, level.mechanics.activatedPlatform]
      : level.platforms;
    const landedPlatform = platforms.find(
      (platform) =>
        (platform.element === 'neutral' || platform.element === role) &&
        player.velocityY <= 0 &&
        previousY >= platform.y &&
        player.y <= platform.y &&
        overlapsHorizontally(player, platform, level.playerWidth),
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
      return (
        player.velocityY <= 0 &&
        previousY >= rampSurfaceY(ramp, previousCenterX) - 0.12 &&
        player.y <= rampSurfaceY(ramp, playerCenterX) + 0.12
      );
    });
    if (landedRamp) {
      player.y = rampSurfaceY(landedRamp, playerCenterX);
      player.velocityY = 0;
      player.grounded = true;
      // Ramp support must not skip the pushable's side collision.
    }
    if (level.mechanics?.pushable && Number.isFinite(mechanicState?.pushableX)) {
      const pushable = level.mechanics.pushable;
      const pushableX = mechanicState.pushableX;
      const pushableY = pushableSupportY(level, pushableX);
      const overlapsPushable =
        player.x + level.playerWidth > pushableX && player.x < pushableX + pushable.width;
      if (
        overlapsPushable &&
        player.velocityY <= 0 &&
        previousY >= pushableY + pushable.height &&
        player.y <= pushableY + pushable.height
      ) {
        player.y = pushableY + pushable.height;
        player.velocityY = 0;
        player.grounded = true;
        continue;
      }
      if (
        player.y < pushableY + pushable.height - 0.05 &&
        player.y + level.playerWidth > pushableY
      ) {
        const previousCenter = previousX + level.playerWidth / 2;
        const pushableCenter = pushableX + pushable.width / 2;
        if (previousCenter <= pushableCenter && player.x + level.playerWidth > pushableX)
          player.x = pushableX - level.playerWidth;
        else if (previousCenter > pushableCenter && player.x < pushableX + pushable.width)
          player.x = pushableX + pushable.width;
      }
    }
    if (landedRamp) {
      player.y = rampSurfaceY(landedRamp, player.x + level.playerWidth / 2);
      continue;
    }
    if (player.y <= 0) {
      player.y = 0;
      player.velocityY = 0;
      player.grounded = true;
    }
    const centerX = player.x + level.playerWidth / 2;
    const lethalHazard = level.hazards.find(
      (hazard) =>
        !(activatedPlatformActive && level.mechanics?.activatedPlatform?.hazardId === hazard.id) &&
        role !== hazard.safeRole &&
        player.y <= 0.05 &&
        centerX >= hazard.x &&
        centerX <= hazard.x + hazard.width,
    );
    if (lethalHazard) {
      Object.assign(player, createPlaytestPlayer(level, role));
      return { died: true, hazardId: lethalHazard.id };
    }
  }
  return { died: false, hazardId: null };
}

/** Collision-aware left, neutral, and right jump traces from an authored position. */
export function traceJumpReach(level, origin, role) {
  return [-1, 0, 1].map((moveX) => {
    const player = {
      x: Math.max(0, Math.min(level.width - level.playerWidth, origin.x)),
      y: Math.max(0, origin.y),
      velocityX: 0,
      velocityY: 0,
      grounded: true,
    };
    const points = [{ x: player.x + level.playerWidth / 2, y: player.y }];
    let died = false;
    for (let frame = 0; frame < 120; frame += 1) {
      const result = stepPlaytestPlayer(level, player, { moveX, jump: frame === 0 }, role, 1 / 60);
      if (result.died) {
        died = true;
        break;
      }
      if (frame % 2 === 0) points.push({ x: player.x + level.playerWidth / 2, y: player.y });
      if (frame > 8 && player.grounded) break;
    }
    return { moveX, points, died, landing: points.at(-1) };
  });
}

/** Maps native trackpad gestures without conflating two-finger scroll and pinch. */
export function nextTrackpadCamera(camera, gesture, viewport, worldViewHeight = 19) {
  if (!gesture.pinching) {
    const horizontalDelta =
      gesture.shiftKey && gesture.deltaX === 0 ? gesture.deltaY : gesture.deltaX;
    return {
      zoom: camera.zoom,
      pan: {
        x: camera.pan.x - horizontalDelta,
        y: camera.pan.y - (gesture.shiftKey && gesture.deltaX === 0 ? 0 : gesture.deltaY),
      },
    };
  }

  const oldScale = (viewport.height / worldViewHeight) * camera.zoom;
  const worldX = (gesture.pointerX - camera.pan.x) / oldScale;
  const worldY = (viewport.height + camera.pan.y - gesture.pointerY) / oldScale;
  const nextZoom = Math.max(
    CAMERA_MIN_ZOOM,
    Math.min(3, camera.zoom * Math.exp(-gesture.deltaY * 0.01)),
  );
  const nextScale = (viewport.height / worldViewHeight) * nextZoom;
  return {
    zoom: nextZoom,
    pan: {
      x: gesture.pointerX - worldX * nextScale,
      y: worldY * nextScale + gesture.pointerY - viewport.height,
    },
  };
}

/** Fits a complete world-space rectangle inside the editor viewport. */
export function fitCameraToBounds(bounds, viewport, worldViewHeight = 19, padding = 24) {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const worldWidth = Math.max(0.01, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(0.01, bounds.maxY - bounds.minY);
  const scale = Math.min(availableWidth / worldWidth, availableHeight / worldHeight);
  const renderedWidth = worldWidth * scale;
  const renderedHeight = worldHeight * scale;
  const left = (viewport.width - renderedWidth) / 2;
  const top = (viewport.height - renderedHeight) / 2;

  return {
    zoom: scale / (viewport.height / worldViewHeight),
    pan: {
      x: left - bounds.minX * scale,
      y: top - viewport.height + bounds.maxY * scale,
    },
  };
}
