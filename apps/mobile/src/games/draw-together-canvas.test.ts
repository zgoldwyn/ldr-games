import { describe, expect, it } from 'vitest';

import {
  applyDrawStrokeBatch,
  drawPointOnCanvas,
  drawStrokeBatches,
  normalizeDrawPoint,
  type DrawStroke,
} from './draw-together-canvas';

describe('Draw Together canvas transport', () => {
  it('normalizes coordinates across different canvas sizes', () => {
    const point = normalizeDrawPoint(150, 100, 300, 200);
    expect(point).toEqual({ x: 0.5, y: 0.5 });
    expect(drawPointOnCanvas(point, 600, 400)).toEqual({ x: 300, y: 200 });
  });

  it('clamps pointer coordinates to the canvas', () => {
    expect(normalizeDrawPoint(-5, 300, 100, 100)).toEqual({ x: 0, y: 1 });
  });

  it('creates bounded ordered stroke batches', () => {
    const stroke: DrawStroke = {
      id: 'stroke-1',
      color: '#123456',
      width: 8,
      points: Array.from({ length: 25 }, (_, index) => ({ x: index / 25, y: 0.5 })),
    };
    const batches = drawStrokeBatches(stroke, 12);
    expect(batches.map((batch) => batch.points.length)).toEqual([12, 12, 1]);
    expect(batches.map((batch) => batch.sequence)).toEqual([0, 1, 2]);
    expect(batches.map((batch) => batch.final)).toEqual([false, false, true]);
  });

  it('ignores duplicates and detects sequence gaps', () => {
    const first = applyDrawStrokeBatch(undefined, {
      strokeId: 'stroke-1',
      sequence: 0,
      color: '#123456',
      width: 8,
      points: [{ x: 0, y: 0 }],
      final: false,
    });
    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') throw new Error('expected an applied batch');

    expect(
      applyDrawStrokeBatch(first.buffer, {
        strokeId: 'stroke-1',
        sequence: 0,
        color: '#123456',
        width: 8,
        points: [{ x: 0, y: 0 }],
        final: false,
      }).kind,
    ).toBe('duplicate');
    expect(
      applyDrawStrokeBatch(first.buffer, {
        strokeId: 'stroke-1',
        sequence: 2,
        color: '#123456',
        width: 8,
        points: [{ x: 1, y: 1 }],
        final: true,
      }),
    ).toEqual({ kind: 'gap', expectedSequence: 1 });
  });

  it('rejects malformed negative sequences without manufacturing a buffer', () => {
    expect(
      applyDrawStrokeBatch(undefined, {
        strokeId: 'stroke-1',
        sequence: -1,
        color: '#123456',
        width: 8,
        points: [],
        final: false,
      }),
    ).toEqual({ kind: 'gap', expectedSequence: 0 });
  });
});
