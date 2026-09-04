/**
 * Real `supabase-js` implementation of {@link ConnectionPorts} (Requirements
 * 2.9, 6.2, 6.4, 6.6).
 *
 * Thin, like `sync/supabase-ports.ts`: build a channel, forward events, POST the
 * presence snapshot. Every decision — which revoke to obey, when a report is
 * due, which module owns an event — lives in `connection-manager.ts` where it is
 * unit-testable without a stack.
 *
 * The topic names are the server's, from
 * `supabase/functions/_shared/realtime.ts`: `account:{id}` and
 * `rt_session:{id}`. Presence and Broadcast share the ONE game channel, matching
 * `gameChannelTopic`, so a playing client receives the whole stream — moves,
 * pause, resume, outcome — over a single subscription.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import type { AccountId, SessionId } from '../domain/common.js';
import type { PresenceState } from '../domain/game.js';
import type { ChannelStatus } from '../sync/connectivity.js';
import type { CancelSchedule, ConnectionPorts } from './connection-manager.js';

/** Per-account Realtime topic; mirrors the server's `accountTopic`. */
export function accountTopic(accountId: string): string {
  return `account:${accountId}`;
}

/** Per-session Realtime topic; mirrors the server's `gameChannelTopic`. */
export function gameChannelTopic(sessionId: string): string {
  return `rt_session:${sessionId}`;
}

/** Shape supabase-js delivers for a Broadcast message. */
interface BroadcastMessage {
  readonly event?: string;
  readonly payload?: Record<string, unknown>;
}

/** One Presence entry as tracked by a client on the game channel. */
interface PresenceMeta {
  readonly accountId?: string;
}

/**
 * The account ids currently present, from a Presence state snapshot.
 *
 * Presence keys are chosen by whoever calls `track`, so this reads the
 * `accountId` carried in the metadata and falls back to the key. That keeps it
 * working whether a client keys by account id or by a per-connection id.
 */
function presentAccountIds(
  state: Record<string, readonly PresenceMeta[]>,
): readonly AccountId[] {
  const ids: AccountId[] = [];
  for (const [key, metas] of Object.entries(state)) {
    const fromMeta = metas.find((meta) => typeof meta.accountId === 'string')?.accountId;
    ids.push((fromMeta ?? key) as AccountId);
  }
  return ids;
}

/** Build {@link ConnectionPorts} over an authenticated Supabase client. */
export function createSupabaseConnectionPorts(client: SupabaseClient): ConnectionPorts {
  return {
    subscribeAccount(accountId: AccountId, handlers): () => void {
      const channel: RealtimeChannel = client.channel(accountTopic(accountId));

      channel.on('broadcast', { event: '*' }, (message: BroadcastMessage) => {
        handlers.onEvent(String(message.event ?? ''), message.payload ?? {});
      });

      channel.subscribe((status: string) => {
        handlers.onStatus(status as ChannelStatus);
      });

      return () => {
        void client.removeChannel(channel);
      };
    },

    subscribeGameSession(sessionId: SessionId, self: AccountId, handlers): () => void {
      // `presence.key` makes this client's own entry addressable by account id,
      // so the partner's roster names accounts rather than socket ids.
      const channel: RealtimeChannel = client.channel(gameChannelTopic(sessionId), {
        config: { presence: { key: self } },
      });

      channel.on('broadcast', { event: '*' }, (message: BroadcastMessage) => {
        handlers.onEvent(String(message.event ?? ''), message.payload ?? {});
      });

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as unknown as Record<
          string,
          readonly PresenceMeta[]
        >;
        handlers.onPresenceSync(presentAccountIds(state));
      });

      channel.on('presence', { event: 'join' }, ({ key }: { key: string }) => {
        handlers.onPresenceJoin(key as AccountId);
      });

      channel.on('presence', { event: 'leave' }, ({ key }: { key: string }) => {
        handlers.onPresenceLeave(key as AccountId);
      });

      channel.subscribe((status: string) => {
        handlers.onStatus(status as ChannelStatus);
        // Track only once SUBSCRIBED: tracking earlier is dropped, and this
        // client would then be invisible to the partner's roster — which reads
        // as a permanent disconnect and would pause the game on a live player.
        if (status === 'SUBSCRIBED') {
          void channel.track({ accountId: self, onlineAt: new Date().toISOString() });
        }
      });

      return () => {
        void channel.untrack();
        void client.removeChannel(channel);
      };
    },

    async reportPresence(
      sessionId: SessionId,
      samples: readonly PresenceState[],
    ): Promise<void> {
      const { error } = await client.functions.invoke('rt-presence', {
        body: { sessionId, presence: samples },
      });
      // Throw so the manager's catch treats it as a failed report and retries on
      // the next interval; the pause is not lost, only deferred.
      if (error) throw error;
    },

    now: () => Date.now(),

    schedule(fn: () => void, ms: number): CancelSchedule {
      const handle = setTimeout(fn, ms);
      return () => {
        clearTimeout(handle);
      };
    },
  };
}
