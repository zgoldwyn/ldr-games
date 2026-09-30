import { describe, expect, it } from 'vitest';
import { ELEMENTAL_DUNGEON_LEVEL, ELEMENTAL_GROVE_LEVEL } from '@ldr/core';

import type { StringStore } from '../session/string-store';
import {
  bestTicksForLevel,
  loadElementalBestTimes,
  recordElementalBestTime,
} from './elemental-best-times';

function memoryStore(): StringStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

describe('Ember and Tide records', () => {
  it('keeps the fastest completion for each level separately', async () => {
    const kv = memoryStore();
    await recordElementalBestTime(kv, 'pair', ELEMENTAL_GROVE_LEVEL, 300);
    await recordElementalBestTime(kv, 'pair', ELEMENTAL_GROVE_LEVEL, 330);
    await recordElementalBestTime(kv, 'pair', ELEMENTAL_DUNGEON_LEVEL, 420);
    const records = await recordElementalBestTime(kv, 'pair', ELEMENTAL_GROVE_LEVEL, 270);
    expect(bestTicksForLevel(records, ELEMENTAL_GROVE_LEVEL)).toBe(270);
    expect(bestTicksForLevel(records, ELEMENTAL_DUNGEON_LEVEL)).toBe(420);
    expect(
      bestTicksForLevel(await loadElementalBestTimes(kv, 'other'), ELEMENTAL_GROVE_LEVEL),
    ).toBeNull();
  });

  it('clears all saved levels when the authored catalog changes', async () => {
    const kv = memoryStore();
    await recordElementalBestTime(kv, 'pair', ELEMENTAL_GROVE_LEVEL, 300);
    await recordElementalBestTime(kv, 'pair', ELEMENTAL_DUNGEON_LEVEL, 420);
    const key = 'ember-tide-best-times:pair';
    const saved = JSON.parse(kv.values.get(key)!) as { catalogFingerprint: string };
    saved.catalogFingerprint = 'old-level-set';
    kv.values.set(key, JSON.stringify(saved));
    expect(await loadElementalBestTimes(kv, 'pair')).toEqual({});
    expect(JSON.parse(kv.values.get(key)!)).toMatchObject({ bestByLevel: {} });
  });
});
