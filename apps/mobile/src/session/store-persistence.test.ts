import { describe, expect, it } from 'vitest';

import { createLocalStore } from '@ldr/core';

import { hydrateStore, persistStore } from './store-persistence';
import type { StringStore } from './string-store';

function memoryStore(): StringStore {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

describe('local store persistence', () => {
  it('hydrates a store from a snapshot written earlier', async () => {
    const kv = memoryStore();
    const original = createLocalStore();
    original.put('notification', 'n1', { id: 'n1' }, 3);
    await persistStore(original, kv);

    const restored = createLocalStore();
    await hydrateStore(restored, kv);
    expect(restored.get('notification', 'n1')).toEqual({ id: 'n1' });
  });

  it('leaves the store empty when nothing was persisted', async () => {
    const restored = createLocalStore();
    await hydrateStore(restored, memoryStore());
    expect(restored.list('notification')).toEqual([]);
  });
});
