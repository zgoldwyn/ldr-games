import { describe, expect, it } from 'vitest';

import { classicFleet } from './battleship-fleet';

describe('classicFleet', () => {
  it('places a non-empty classic fleet inside a 10×10 grid', () => {
    const cells = classicFleet();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(10);
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(10);
    }
  });

  it('does not overlap its own ships', () => {
    const keys = classicFleet().map((c) => `${c.row},${c.col}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
