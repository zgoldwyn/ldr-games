const DEFAULT_PAIRING_REFRESH_MS = 1_500;

export interface PairingRefreshWatcherOptions {
  /** Server-backed check; true once another device has accepted the invitation. */
  readonly isPaired: () => Promise<boolean>;
  /** Refresh the shell identity so its navigation gate enters the paired stack. */
  readonly onPaired: () => Promise<void> | void;
  readonly intervalMs?: number;
}

/**
 * Poll the account's server-backed pairing state while the unpaired screen is
 * mounted. The accepting device cannot update the inviter's React state, so the
 * inviter needs this bridge until pairing-created has an account Realtime event.
 *
 * Checks never overlap, stop before notifying, and ignore an in-flight result
 * after teardown. The returned function is idempotent.
 */
export function startPairingRefreshWatcher({
  isPaired,
  onPaired,
  intervalMs = DEFAULT_PAIRING_REFRESH_MS,
}: PairingRefreshWatcherOptions): () => void {
  let stopped = false;
  let checking = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  async function check() {
    if (checking || stopped) return;
    checking = true;
    try {
      const paired = await isPaired();
      if (!paired || stopped) return;
      stop();
      await onPaired();
    } finally {
      checking = false;
    }
  }

  const interval = setInterval(() => void check(), intervalMs);
  void check();
  return stop;
}
