/**
 * Local Store: the client-side cache of shared state (Requirements 5.1, 6.1, 7.1).
 *
 * This is the cache design task 14.2 deliberately did NOT make. That task wired
 * the pairing-scoped Postgres Changes subscription but handed remote changes to
 * an `onRemoteChange` listener instead of caching them, explicitly so this task
 * could decide how they are held. Per design.md the Local Store "caches the
 * last-known shared state for instant display and offline reads".
 *
 * Three properties make it worth being a real module rather than a `Map`:
 *
 *  - **Synchronous reads.** A shell renders from cache on the first frame
 *    instead of awaiting a round trip, and keeps rendering while offline.
 *  - **Monotonic writes.** A `put` may carry a `version`; a write whose version
 *    is lower than the cached one is ignored. Without this, a slow response that
 *    left the server before a newer one but arrived after it would rewind the
 *    board in front of the player. Versions must be monotonic per key — the
 *    asynchronous game uses its turn count, which Req 7.5 increments on every
 *    recorded turn.
 *  - **Total clear.** Sign-out and pairing dissolution revoke access to
 *    everything cached (Req 4.4); a partial clear would leave a former partner's
 *    data on screen after the database has already stopped returning it.
 *
 * PERSISTENCE IS NOT HERE. `snapshot`/`hydrate` expose the whole cache so a
 * shell can persist it (task 22.1b owns the platform storage). The core package
 * is platform-neutral and cannot reach AsyncStorage or the filesystem itself.
 */

/** The kinds of shared entity the MVP caches. */
export type EntityKind = 'rt_session' | 'async_session' | 'notification' | 'notification_settings';

/** Called after a change to the subscribed kind. */
export type StoreListener = () => void;

/** The serializable form of the whole cache, for platform persistence. */
export interface StoreSnapshot {
  readonly entities: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly versions: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface LocalStore {
  /** The cached entity, or undefined on a miss. Synchronous by design. */
  get<T>(kind: EntityKind, id: string): T | undefined;
  /** Every cached entity of `kind`, in insertion order. */
  list<T>(kind: EntityKind): readonly T[];
  /**
   * Cache an entity. When `version` is supplied and is lower than the cached
   * version for this key, the write is ignored and no listener fires. Omitting
   * `version` opts out: the write is always applied, which is correct for a
   * caller reading from a single ordered channel.
   */
  put<T>(kind: EntityKind, id: string, value: T, version?: number): void;
  /** Remove one entity. */
  remove(kind: EntityKind, id: string): void;
  /** Drop everything, including the version ledger. */
  clear(): void;
  /** Observe changes to one kind. Returns an unsubscribe function. */
  subscribe(kind: EntityKind, listener: StoreListener): () => void;
  /** The whole cache in serializable form. */
  snapshot(): StoreSnapshot;
  /** Replace the whole cache from a snapshot. */
  hydrate(snapshot: StoreSnapshot): void;
}

/** Build an empty Local Store. */
export function createLocalStore(): LocalStore {
  /** kind -> id -> entity. */
  const entities = new Map<EntityKind, Map<string, unknown>>();
  /** kind -> id -> last applied version. */
  const versions = new Map<EntityKind, Map<string, number>>();
  const listeners = new Map<EntityKind, Set<StoreListener>>();

  function bucket<V>(map: Map<EntityKind, Map<string, V>>, kind: EntityKind): Map<string, V> {
    let existing = map.get(kind);
    if (existing === undefined) {
      existing = new Map<string, V>();
      map.set(kind, existing);
    }
    return existing;
  }

  function notify(kind: EntityKind): void {
    const subscribers = listeners.get(kind);
    if (subscribers === undefined) return;
    // Copied before iterating so a listener that unsubscribes itself during the
    // callback cannot mutate the set mid-iteration.
    for (const listener of [...subscribers]) listener();
  }

  return {
    get<T>(kind: EntityKind, id: string): T | undefined {
      return entities.get(kind)?.get(id) as T | undefined;
    },

    list<T>(kind: EntityKind): readonly T[] {
      const found = entities.get(kind);
      return found === undefined ? [] : ([...found.values()] as T[]);
    },

    put<T>(kind: EntityKind, id: string, value: T, version?: number): void {
      if (version !== undefined) {
        const cached = versions.get(kind)?.get(id);
        // Strictly lower is stale. Equal is allowed through: Realtime can
        // redeliver, and re-applying the current version is not a rewind.
        if (cached !== undefined && version < cached) return;
        bucket(versions, kind).set(id, version);
      }
      bucket(entities, kind).set(id, value);
      notify(kind);
    },

    remove(kind: EntityKind, id: string): void {
      const found = entities.get(kind);
      if (found === undefined || !found.delete(id)) return;
      versions.get(kind)?.delete(id);
      notify(kind);
    },

    clear(): void {
      const kinds = [...entities.keys()];
      entities.clear();
      // The version ledger goes too. Keeping it would let a stale version
      // suppress the first write of a genuinely new entity reusing the id.
      versions.clear();
      for (const kind of kinds) notify(kind);
    },

    subscribe(kind: EntityKind, listener: StoreListener): () => void {
      let subscribers = listeners.get(kind);
      if (subscribers === undefined) {
        subscribers = new Set<StoreListener>();
        listeners.set(kind, subscribers);
      }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    snapshot(): StoreSnapshot {
      const entitySnapshot: Record<string, Record<string, unknown>> = {};
      for (const [kind, values] of entities) {
        entitySnapshot[kind] = Object.fromEntries(values);
      }
      const versionSnapshot: Record<string, Record<string, number>> = {};
      for (const [kind, values] of versions) {
        versionSnapshot[kind] = Object.fromEntries(values);
      }
      return { entities: entitySnapshot, versions: versionSnapshot };
    },

    hydrate(snapshot: StoreSnapshot): void {
      const kinds = new Set<EntityKind>(entities.keys());
      entities.clear();
      versions.clear();

      for (const [kind, values] of Object.entries(snapshot.entities ?? {})) {
        entities.set(kind as EntityKind, new Map(Object.entries(values)));
        kinds.add(kind as EntityKind);
      }
      for (const [kind, values] of Object.entries(snapshot.versions ?? {})) {
        versions.set(kind as EntityKind, new Map(Object.entries(values)));
      }
      for (const kind of kinds) notify(kind);
    },
  };
}
