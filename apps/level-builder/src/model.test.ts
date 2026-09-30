import { describe, expect, it } from 'vitest';

// The browser model intentionally stays dependency-free JavaScript so the editor
// can run without a bundler or install step.
// @ts-expect-error JavaScript browser module has no generated declaration.
import {
  blankLevel,
  cloneLevel,
  createPlaytestPlayer,
  createObject,
  fitCameraToBounds,
  mirrorObjectAcrossStage,
  exportJson,
  exportTypescript,
  importTypescriptLevel,
  nextTrackpadCamera,
  pushableSupportY,
  resolvePushableX,
  resizeRectangle,
  snapJumpOrigin,
  stepPlaytestPlayer,
  traceJumpReach,
  validateLevel,
} from '../public/model.mjs';

describe('Ember & Tide level builder model', () => {
  it('uses level number as both identity and sequence', () => {
    expect(blankLevel(8)).toMatchObject({
      number: 8,
      chapter: 'Level 8',
      id: 'new-level-08',
    });
    const legacy = blankLevel(5);
    legacy.order = 2;
    expect(cloneLevel(legacy)).toMatchObject({ number: 5 });
    expect(cloneLevel(legacy)).not.toHaveProperty('order');
  });

  it('reports incomplete role shard sets in a new level', () => {
    const issues = validateLevel(blankLevel());
    expect(issues.filter((entry: { code: string }) => entry.code === 'shard-count')).toHaveLength(
      2,
    );
  });

  it('reflects copied geometry across the stage center', () => {
    expect(
      mirrorObjectAcrossStage(64, 'platform', {
        id: 'left-platform',
        x: 10,
        y: 5,
        width: 6,
        element: 'neutral',
      }),
    ).toMatchObject({ x: 48, y: 5, width: 6, element: 'neutral' });
    expect(mirrorObjectAcrossStage(64, 'crystal', { id: 'left-shard', x: 10, y: 7 })).toMatchObject(
      { x: 54, y: 7 },
    );
    expect(
      mirrorObjectAcrossStage(64, 'platform', { id: 'decimal', x: 11.7, y: 5, width: 10.1 }).x,
    ).toBe(42.2);
  });

  it('detects low platforms covering poison pools', () => {
    const level = blankLevel();
    level.platforms.push({ id: 'bad-bridge', x: 10, y: 2, width: 5, element: 'neutral' });
    level.hazards.push({ id: 'hidden-pool', x: 12, width: 2, safeRole: 'none' });
    expect(validateLevel(level)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'pool-overlap', severity: 'error' }),
      ]),
    );
  });

  it('detects a gate visual envelope collision', () => {
    const level = blankLevel();
    level.solids.push({ id: 'gate-wall', x: 2, y: 0, width: 2, height: 4 });
    expect(validateLevel(level)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'gate-overlap', severity: 'error' }),
      ]),
    );
  });

  it('exports portable JSON and a core-ready TypeScript constant', () => {
    const level = blankLevel();
    expect(JSON.parse(exportJson(level))).toMatchObject({ id: level.id, width: 64 });
    expect(exportTypescript(level)).toContain('export const ELEMENTAL_UNTITLED_LEVEL_LEVEL');
    expect(exportTypescript(level)).toContain('as const;');
  });

  it('safely imports a builder-exported TypeScript level', () => {
    const level = blankLevel();
    expect(importTypescriptLevel(exportTypescript(level))).toEqual(level);
  });

  it('rejects TypeScript that is not a JSON-shaped exported level constant', () => {
    expect(() => importTypescriptLevel('export const LEVEL = makeLevel();')).toThrow();
  });

  it('authors a complete reversible mechanic set with explicit targets', () => {
    const level = blankLevel();
    createObject(level, 'lever', 10, 0);
    createObject(level, 'pressurePlate', 15, 0);
    createObject(level, 'pushable', 20, 0);
    createObject(level, 'activatedPlatform', 25, 4);

    expect(level.mechanics).toMatchObject({
      lever: { target: 'activatedPlatform' },
      pressurePlate: { target: 'activatedPlatform' },
      pushable: { x: 20, pushSpeed: 6 },
      activatedPlatform: { y: 4 },
    });
    expect(
      validateLevel(level).some((entry: { code: string }) => entry.code === 'mechanic-set'),
    ).toBe(false);
  });

  it('authors mirrored, resizable ramps with real slope direction', () => {
    const level = blankLevel();
    const ref = createObject(level, 'ramp', 12, 2);
    const ramp = level.ramps.find((entry: { id: string }) => entry.id === ref.id);
    expect(ramp).toMatchObject({ width: 6, height: 3, direction: 'up-right' });
    expect(mirrorObjectAcrossStage(level.width, 'ramp', ramp)).toMatchObject({
      x: 46,
      direction: 'up-left',
    });
  });

  it('keeps pushables in bounds and stops them at authored walls', () => {
    const level = blankLevel();
    createObject(level, 'lever', 10, 0);
    createObject(level, 'pressurePlate', 15, 0);
    createObject(level, 'pushable', 20, 0);
    createObject(level, 'activatedPlatform', 25, 4);
    level.solids.push({ id: 'stop-wall', x: 24, y: 0, width: 2, height: 4 });
    expect(resolvePushableX(level, 20, 30)).toBe(22);
    expect(resolvePushableX(level, 20, -10)).toBe(0);
  });

  it('requires partner assistance to move a pushable onto a ramp', () => {
    const level = blankLevel();
    createObject(level, 'lever', 10, 0);
    createObject(level, 'pressurePlate', 15, 0);
    createObject(level, 'pushable', 10, 0);
    createObject(level, 'activatedPlatform', 25, 4);
    level.ramps.push({
      id: 'co-op-ramp',
      x: 11,
      y: 0,
      width: 8,
      height: 4,
      direction: 'up-right',
      element: 'neutral',
    });
    const start = level.mechanics.pushable.x;
    expect(resolvePushableX(level, start, start + 0.5, false)).toBe(start);
    const assisted = resolvePushableX(level, start, start + 0.5, true);
    expect(assisted).toBeGreaterThan(start);
    expect(pushableSupportY(level, assisted)).toBeGreaterThan(0);
  });

  it('requires a transition when outside and underground zones share a level', () => {
    const level = blankLevel();
    createObject(level, 'environmentZone', 30, 0);
    expect(validateLevel(level)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'missing-underground-transition' })]),
    );

    createObject(level, 'entrance', 28, 0);
    expect(
      validateLevel(level).some(
        (entry: { code: string }) => entry.code === 'missing-underground-transition',
      ),
    ).toBe(false);
  });

  it('traces collision-aware jumps in all three movement directions', () => {
    const level = blankLevel();
    const traces = traceJumpReach(level, { x: 20, y: 0 }, 'ember');

    expect(traces.map((trace: { moveX: number }) => trace.moveX)).toEqual([-1, 0, 1]);
    expect(
      Math.max(
        ...traces.flatMap((trace: { points: { y: number }[] }) =>
          trace.points.map((point) => point.y),
        ),
      ),
    ).toBeGreaterThan(3.2);
    expect(traces[0].landing.x).toBeLessThan(traces[1].landing.x);
    expect(traces[2].landing.x).toBeGreaterThan(traces[1].landing.x);
  });

  it('playtest physics lands on role-valid platforms and respawns in lethal pools', () => {
    const level = blankLevel();
    level.platforms.push({ id: 'ember-step', x: 5, y: 2, width: 5, element: 'ember' });
    level.hazards.push({ id: 'water', x: 15, width: 3, safeRole: 'tide' });
    const ember = createPlaytestPlayer(level, 'ember');
    ember.x = 6;
    ember.y = 2.1;
    ember.velocityY = -2;
    ember.grounded = false;

    for (let frame = 0; frame < 4 && !ember.grounded; frame += 1) {
      stepPlaytestPlayer(level, ember, { moveX: 0, jump: false }, 'ember', 1 / 30);
    }
    expect(ember.y).toBe(2);
    expect(ember.grounded).toBe(true);

    ember.x = 15.5;
    ember.y = 0;
    const result = stepPlaytestPlayer(level, ember, { moveX: 0, jump: false }, 'ember', 1 / 60);
    expect(result).toMatchObject({ died: true, hazardId: 'water' });
    expect(ember.x).toBe(level.spawns.ember);
    expect(ember.y).toBe(level.spawnY.ember);
  });

  it('pans for ordinary two-finger scroll without changing zoom', () => {
    expect(
      nextTrackpadCamera(
        { zoom: 1, pan: { x: 24, y: 20 } },
        {
          pinching: false,
          shiftKey: false,
          deltaX: 18,
          deltaY: -12,
          pointerX: 200,
          pointerY: 150,
        },
        { height: 500 },
      ),
    ).toEqual({ zoom: 1, pan: { x: 6, y: 32 } });
  });

  it('pinch-zooms around the pointer while preserving its world position', () => {
    const camera = { zoom: 1, pan: { x: 24, y: 20 } };
    const pointer = { x: 200, y: 150 };
    const viewport = { height: 500 };
    const oldScale = (viewport.height / 19) * camera.zoom;
    const oldWorld = {
      x: (pointer.x - camera.pan.x) / oldScale,
      y: (viewport.height + camera.pan.y - pointer.y) / oldScale,
    };
    const next = nextTrackpadCamera(
      camera,
      {
        pinching: true,
        shiftKey: false,
        deltaX: 0,
        deltaY: -20,
        pointerX: pointer.x,
        pointerY: pointer.y,
      },
      viewport,
    );
    const nextScale = (viewport.height / 19) * next.zoom;

    expect(next.zoom).toBeGreaterThan(camera.zoom);
    expect((pointer.x - next.pan.x) / nextScale).toBeCloseTo(oldWorld.x);
    expect((viewport.height + next.pan.y - pointer.y) / nextScale).toBeCloseTo(oldWorld.y);
  });

  it('fits the complete stage inside the viewport', () => {
    const viewport = { width: 900, height: 600 };
    const bounds = { minX: 0, maxX: 80, minY: -1, maxY: 29 };
    const camera = fitCameraToBounds(bounds, viewport);
    const scale = (viewport.height / 19) * camera.zoom;
    const left = camera.pan.x + bounds.minX * scale;
    const right = camera.pan.x + bounds.maxX * scale;
    const top = viewport.height + camera.pan.y - bounds.maxY * scale;
    const bottom = viewport.height + camera.pan.y - bounds.minY * scale;

    expect(left).toBeGreaterThanOrEqual(24);
    expect(right).toBeLessThanOrEqual(viewport.width - 24);
    expect(top).toBeGreaterThanOrEqual(24);
    expect(bottom).toBeLessThanOrEqual(viewport.height - 24);
  });

  it('snaps jump reach tests to the nearest usable platform edge', () => {
    const level = blankLevel();
    level.platforms.push({ id: 'ledge', x: 10, y: 6, width: 8, element: 'neutral' });

    expect(snapJumpOrigin(level, { x: 17.8, y: 6.1 }, 'ember')).toMatchObject({
      x: 16.4,
      y: 6,
      edgeX: 18,
      snappedEdge: true,
    });
  });

  it('does not snap jump reach to a platform the role cannot use', () => {
    const level = blankLevel();
    level.platforms.push({ id: 'tide-only', x: 10, y: 6, width: 8, element: 'tide' });

    expect(snapJumpOrigin(level, { x: 10.1, y: 6 }, 'ember').snappedEdge).toBe(false);
  });

  it('projects a jump reach origin to the highest usable surface directly below', () => {
    const level = blankLevel();
    level.solids.push({ id: 'lower', x: 10, y: 2, width: 8, height: 2 });
    level.platforms.push({ id: 'upper', x: 10, y: 8, width: 8, element: 'neutral' });

    expect(snapJumpOrigin(level, { x: 14, y: 14 }, 'ember')).toMatchObject({
      x: 13.2,
      y: 8,
      snappedEdge: false,
      snappedSurface: true,
    });
  });

  it('bypasses jump edge snapping when snapping is disabled', () => {
    const level = blankLevel();
    level.platforms.push({ id: 'ledge', x: 10, y: 6, width: 8, element: 'neutral' });

    expect(snapJumpOrigin(level, { x: 10.1, y: 6 }, 'ember', -1)).toMatchObject({
      snappedEdge: false,
      edgeX: null,
    });
  });

  it('resizes from corners while keeping the opposite corner fixed', () => {
    expect(
      resizeRectangle({ x: 10, y: 4, width: 6, height: 3 }, 'ne', { x: 2.1, y: 1.2 }, 0.5),
    ).toEqual({ x: 10, y: 4, width: 8, height: 4 });
  });

  it('does not draw the respawn teleport as part of a lethal jump trace', () => {
    const level = blankLevel();
    level.spawns.ember = 1;
    level.hazards.push({ id: 'lava', x: 19, width: 4, safeRole: 'tide' });
    const trace = traceJumpReach(level, { x: 20, y: 0 }, 'ember').find((item) => item.moveX === 0);
    const spawnCenter = level.spawns.ember + level.playerWidth / 2;

    expect(trace?.died).toBe(true);
    expect(trace?.points.some((point) => Math.abs(point.x - spawnCenter) < 0.01)).toBe(false);
  });
});
