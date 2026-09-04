import { describe, expect, it, vi } from 'vitest';

import { createLocalStore, type LocalStore } from './local-store.js';

// Unit tests for the Local Store (Req 5.1, 6.1, 7.1).
//
// The store is the cache design task 14.2 deliberately deferred: it handed remote
// changes to an `onRemoteChange` listener rather than caching them, leaving this
// task to decide how they are held. What is worth pinning here is the behaviour a
// shell depends on — synchronous reads for instant display, change notification
// so a screen re-renders, monotonic writes so a late response cannot rewind
// state, and a total clear so one account's data never survives into another's.

interface Session {
  readonly id: string;
  readonly turns: number;
}

const A: Session = { id: 'a', turns: 0 };
const B: Session = { id: 'b', turns: 0 };

function store(): LocalStore {
  return createLocalStore();
}

describe('LocalStore reads', () => {
  it('reads back a written entity synchronously', () => {
    const s = store();
    s.put('async_session', A.id, A);
    // Synchronous by design: a shell renders from cache on the first frame
    // rather than awaiting a round trip (design.md, Local Store).
    expect(s.get<Session>('async_session', A.id)).toEqual(A);
  });

  it('returns undefined for an unknown id', () => {
    expect(store().get('async_session', 'nope')).toBeUndefined();
  });

  it('lists every entity of a kind without mixing kinds', () => {
    const s = store();
    s.put('async_session', A.id, A);
    s.put('async_session', B.id, B);
    s.put('rt_session', 'rt', { id: 'rt', turns: 0 });

    expect(s.list<Session>('async_session').map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(s.list('rt_session')).toHaveLength(1);
  });

  it('replaces an entity written under the same key', () => {
    const s = store();
    s.put('async_session', A.id, A);
    s.put('async_session', A.id, { ...A, turns: 3 });
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(3);
    expect(s.list('async_session')).toHaveLength(1);
  });

  it('removes an entity', () => {
    const s = store();
    s.put('async_session', A.id, A);
    s.remove('async_session', A.id);
    expect(s.get('async_session', A.id)).toBeUndefined();
  });
});

describe('LocalStore monotonic writes', () => {
  it('ignores a write carrying a lower version', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 5 }, 5);
    // A response that left the server BEFORE the newer one but arrived after it.
    // Applying it would rewind the board in front of the player.
    s.put('async_session', A.id, { ...A, turns: 3 }, 3);
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(5);
  });

  it('applies a write carrying a higher version', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 3 }, 3);
    s.put('async_session', A.id, { ...A, turns: 4 }, 4);
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(4);
  });

  it('applies an equal version, so a re-delivered current state still lands', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 3 }, 3);
    // Realtime can redeliver; the newer copy of the same version is not a rewind.
    s.put('async_session', A.id, { ...A, turns: 3, id: 'a' }, 3);
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(3);
  });

  it('treats an unversioned write as always newest', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 5 }, 5);
    s.put('async_session', A.id, { ...A, turns: 1 });
    // Opting out of versioning is explicit: callers on an ordered channel say so
    // by omitting the version rather than inventing one.
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(1);
  });
});

describe('LocalStore subscriptions', () => {
  it('notifies a subscriber of its own kind only', () => {
    const s = store();
    const onAsync = vi.fn();
    s.subscribe('async_session', onAsync);

    s.put('async_session', A.id, A);
    s.put('rt_session', 'rt', { id: 'rt' });

    expect(onAsync).toHaveBeenCalledTimes(1);
  });

  it('notifies on remove', () => {
    const s = store();
    s.put('async_session', A.id, A);
    const listener = vi.fn();
    s.subscribe('async_session', listener);
    s.remove('async_session', A.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when a stale write is ignored', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 5 }, 5);
    const listener = vi.fn();
    s.subscribe('async_session', listener);
    s.put('async_session', A.id, { ...A, turns: 2 }, 2);
    // Nothing changed, so a re-render would be a wasted frame.
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const s = store();
    const listener = vi.fn();
    const off = s.subscribe('async_session', listener);
    off();
    s.put('async_session', A.id, A);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('LocalStore clear', () => {
  it('drops every kind', () => {
    const s = store();
    s.put('async_session', A.id, A);
    s.put('rt_session', 'rt', { id: 'rt' });
    s.put('notification', 'n', { id: 'n' });

    s.clear();

    // Sign-out and pairing dissolution both revoke access to everything cached
    // (Req 4.4). A partial clear would leave a former partner's data on screen.
    expect(s.list('async_session')).toHaveLength(0);
    expect(s.list('rt_session')).toHaveLength(0);
    expect(s.list('notification')).toHaveLength(0);
  });

  it('clears the version ledger too, so a fresh write is not treated as stale', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 9 }, 9);
    s.clear();
    // A new session reusing the id must not be suppressed by the old version.
    s.put('async_session', A.id, { ...A, turns: 1 }, 1);
    expect(s.get<Session>('async_session', A.id)?.turns).toBe(1);
  });
});

describe('LocalStore persistence', () => {
  it('round-trips through snapshot and hydrate', () => {
    const s = store();
    s.put('async_session', A.id, A, 2);
    s.put('notification', 'n', { id: 'n' });

    const revived = store();
    revived.hydrate(s.snapshot());

    // What makes the cache useful on a cold start with no network: the shell
    // persists this snapshot and hands it back (task 22.1b owns the storage).
    expect(revived.get<Session>('async_session', A.id)).toEqual(A);
    expect(revived.list('notification')).toHaveLength(1);
  });

  it('preserves versions across hydrate so a stale write is still refused', () => {
    const s = store();
    s.put('async_session', A.id, { ...A, turns: 7 }, 7);

    const revived = store();
    revived.hydrate(s.snapshot());
    revived.put('async_session', A.id, { ...A, turns: 4 }, 4);

    expect(revived.get<Session>('async_session', A.id)?.turns).toBe(7);
  });

  it('replaces existing contents rather than merging', () => {
    const s = store();
    s.put('async_session', 'stale', { id: 'stale', turns: 0 });
    s.hydrate(store().snapshot());
    expect(s.list('async_session')).toHaveLength(0);
  });
});
