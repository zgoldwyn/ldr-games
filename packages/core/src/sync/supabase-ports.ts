/**
 * Real `supabase-js` implementation of {@link SyncPorts} (Requirements 5.3, 5.5).
 *
 * This is the ONLY part of the client sync path that touches the Supabase
 * client. It is deliberately thin — construct a channel, forward events, POST to
 * the write path — so that all the branching logic lives in
 * {@link createSyncModule} where it can be unit-tested without a stack. Anything
 * with an interesting decision in it belongs there, not here.
 *
 * Task 21.3 composes this into the full Connection Manager and adds the
 * Broadcast and Presence channels alongside it.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import type { PairingId } from '../domain/common.js';
import type { AppliedChange, DataChange } from '../domain/sync.js';
import type { ChannelStatus } from './connectivity.js';
import type { RemoteChange, SyncPorts } from './sync-module.js';

/**
 * Tables carrying pairing-scoped shared data. The subscription is restricted to
 * these so a client is not woken for every write in the database.
 *
 * `notifications` is absent on purpose: it is recipient-scoped, not
 * pairing-scoped, and gets its own subscription in task 19.1.
 */
export const PAIRING_SCOPED_TABLES: readonly string[] = [
  'relationship_dates',
  'reminders',
  'rt_sessions',
  'async_sessions',
  'quiz_sessions',
];

/** Name of the Edge Function implementing the server-authoritative write path. */
const SYNC_WRITE_FUNCTION = 'sync-write';

/** Response envelope returned by the `sync-write` Edge Function. */
interface SyncWriteResponse {
  readonly results?: readonly AppliedChange[];
}

/**
 * Build {@link SyncPorts} backed by a real authenticated Supabase client.
 *
 * `client` must already carry the user's session: the Postgres Changes stream is
 * filtered by RLS as well as by the `pairing_id` filter below, and the write path
 * derives the calling account from the JWT.
 */
export function createSupabaseSyncPorts(client: SupabaseClient): SyncPorts {
  return {
    subscribePairing(pairingId: PairingId, handlers): () => void {
      // One channel per pairing, carrying a `postgres_changes` binding per
      // pairing-scoped table. The `filter` is applied by the Realtime server, so
      // another pairing's rows are never sent to this client in the first place.
      const channel: RealtimeChannel = client.channel(`pairing:${pairingId}`);

      for (const table of PAIRING_SCOPED_TABLES) {
        channel.on(
          // The literal is required by supabase-js's overload; the enum member
          // is not exported in a form usable from a type-only import.
          'postgres_changes' as never,
          {
            event: '*',
            schema: 'public',
            table,
            filter: `pairing_id=eq.${pairingId}`,
          } as never,
          (payload: {
            eventType?: string;
            new?: Record<string, unknown>;
            old?: Record<string, unknown>;
          }) => {
            const event = (payload.eventType ?? 'UPDATE') as RemoteChange['event'];
            // DELETE carries only the old row (and only its replica-identity
            // columns), so fall back to it rather than reporting an empty row.
            const row = payload.new ?? payload.old ?? {};
            handlers.onChange({ event, table, row });
          },
        );
      }

      channel.subscribe((status: string) => {
        handlers.onStatus(status as ChannelStatus);
      });

      return () => {
        void client.removeChannel(channel);
      };
    },

    async postChanges(changes: readonly DataChange[]): Promise<readonly AppliedChange[]> {
      const { data, error } = await client.functions.invoke<SyncWriteResponse>(
        SYNC_WRITE_FUNCTION,
        { body: { changes } },
      );

      // REJECT rather than returning empty: the module distinguishes "the server
      // decided" from "the request never landed", and only the latter may leave
      // changes queued. Resolving with [] here would silently drop them.
      if (error) {
        throw error;
      }
      if (!data?.results) {
        throw new Error('sync-write returned no results');
      }
      return data.results;
    },

    now: () => Date.now(),
  };
}
