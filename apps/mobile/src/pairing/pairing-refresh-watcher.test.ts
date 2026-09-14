import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startPairingRefreshWatcher } from './pairing-refresh-watcher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('pairing refresh watcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks immediately and refreshes when another device creates the pairing', async () => {
    const isPaired = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onPaired = vi.fn();

    startPairingRefreshWatcher({ isPaired, onPaired, intervalMs: 100 });
    await settle();
    expect(isPaired).toHaveBeenCalledTimes(1);
    expect(onPaired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(isPaired).toHaveBeenCalledTimes(2);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('stops polling after the pairing is detected', async () => {
    const isPaired = vi.fn().mockResolvedValue(true);
    const onPaired = vi.fn();

    startPairingRefreshWatcher({ isPaired, onPaired, intervalMs: 100 });
    await settle();
    await vi.advanceTimersByTimeAsync(500);

    expect(isPaired).toHaveBeenCalledTimes(1);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('does not overlap checks when the server read is still in flight', async () => {
    const first = deferred<boolean>();
    const isPaired = vi.fn().mockReturnValue(first.promise);

    const stop = startPairingRefreshWatcher({ isPaired, onPaired: vi.fn(), intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    expect(isPaired).toHaveBeenCalledTimes(1);

    first.resolve(false);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(isPaired).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores an in-flight paired result after the screen unmounts', async () => {
    const result = deferred<boolean>();
    const onPaired = vi.fn();
    const stop = startPairingRefreshWatcher({
      isPaired: () => result.promise,
      onPaired,
      intervalMs: 100,
    });

    stop();
    result.resolve(true);
    await settle();
    await vi.advanceTimersByTimeAsync(500);

    expect(onPaired).not.toHaveBeenCalled();
  });

  it('can be stopped more than once', () => {
    const stop = startPairingRefreshWatcher({
      isPaired: async () => false,
      onPaired: vi.fn(),
    });
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});
