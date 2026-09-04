import type { LocalStore, StoreSnapshot } from '@ldr/core';

import type { StringStore } from './string-store';

/** AsyncStorage key for the Local Store snapshot. */
export const STORE_SNAPSHOT_KEY = 'ldr.local-store';

/** Write the cache so a later launch can render instantly (Req 5.1). */
export async function persistStore(store: LocalStore, kv: StringStore): Promise<void> {
  await kv.setItem(STORE_SNAPSHOT_KEY, JSON.stringify(store.snapshot()));
}

/** Replace the in-memory cache from the last snapshot, or leave it empty. */
export async function hydrateStore(store: LocalStore, kv: StringStore): Promise<void> {
  const raw = await kv.getItem(STORE_SNAPSHOT_KEY);
  if (raw === null || raw.length === 0) return;
  try {
    const snapshot = JSON.parse(raw) as StoreSnapshot;
    if (snapshot.entities === undefined || snapshot.versions === undefined) return;
    store.hydrate(snapshot);
  } catch {
    // A corrupt snapshot is dropped rather than crashing launch; the modules
    // will refill from the network.
  }
}
