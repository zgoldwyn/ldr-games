import { AppState, type AppStateStatus } from 'react-native';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type PartnerPresenceStatus = 'checking' | 'online' | 'offline';

export interface PartnerAppPresence {
  readonly status: PartnerPresenceStatus;
  readonly updatedAt: number | null;
}

export const INITIAL_PARTNER_PRESENCE: PartnerAppPresence = {
  status: 'checking',
  updatedAt: null,
};

interface PresenceMeta {
  readonly accountId?: string;
}

const PRESENCE_POLL_MS = 5_000;
const PRESENCE_HEARTBEAT_MS = 15_000;

function hasAccount(state: Record<string, readonly PresenceMeta[]>, accountId: string): boolean {
  return Object.entries(state).some(
    ([key, entries]) => key === accountId || entries.some((entry) => entry.accountId === accountId),
  );
}

/**
 * Tracks foreground app presence for a pairing, independently of any game room.
 * Backgrounding the app explicitly untracks the account, while the short poll
 * also recovers the UI if a native presence event is delayed.
 */
export function subscribePartnerAppPresence({
  client,
  pairingId,
  selfAccountId,
  partnerAccountId,
  onChange,
}: {
  readonly client: SupabaseClient;
  readonly pairingId: string;
  readonly selfAccountId: string;
  readonly partnerAccountId: string;
  readonly onChange: (presence: PartnerAppPresence) => void;
}): () => void {
  let appState: AppStateStatus = AppState.currentState;
  let subscribed = false;
  let disposed = false;
  let lastStatus: PartnerPresenceStatus = 'checking';
  let lastHeartbeatAt = 0;

  const channel: RealtimeChannel = client.channel(`app_presence:${pairingId}`, {
    config: { presence: { key: selfAccountId } },
  });

  const emit = (status: PartnerPresenceStatus) => {
    if (disposed || status === lastStatus) return;
    lastStatus = status;
    onChange({ status, updatedAt: Date.now() });
  };

  const readPartner = () => {
    if (!subscribed) return;
    const state = channel.presenceState() as unknown as Record<string, readonly PresenceMeta[]>;
    emit(hasAccount(state, partnerAccountId) ? 'online' : 'offline');
  };

  const trackSelf = () => {
    if (!subscribed || appState !== 'active') return;
    lastHeartbeatAt = Date.now();
    void channel.track({
      accountId: selfAccountId,
      active: true,
      heartbeatAt: new Date(lastHeartbeatAt).toISOString(),
    });
  };

  channel.on('presence', { event: 'sync' }, readPartner);
  channel.on('presence', { event: 'join' }, readPartner);
  channel.on('presence', { event: 'leave' }, readPartner);
  channel.subscribe((status: string) => {
    if (disposed) return;
    if (status === 'SUBSCRIBED') {
      subscribed = true;
      trackSelf();
      readPartner();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      subscribed = false;
      emit('checking');
    }
  });

  const appStateSubscription = AppState.addEventListener('change', (nextState) => {
    appState = nextState;
    if (!subscribed) return;
    if (nextState === 'active') {
      trackSelf();
      readPartner();
    } else {
      void channel.untrack();
    }
  });

  const poll = setInterval(() => {
    readPartner();
    if (Date.now() - lastHeartbeatAt >= PRESENCE_HEARTBEAT_MS) trackSelf();
  }, PRESENCE_POLL_MS);

  return () => {
    disposed = true;
    clearInterval(poll);
    appStateSubscription.remove();
    void channel.untrack();
    void client.removeChannel(channel);
  };
}
