/**
 * Real `supabase-js` implementation of {@link NotificationPorts}
 * (Requirements 11.1, 11.2, 11.3, 11.6).
 *
 * Thin adapter. Authorization is entirely RLS: `notifications` carries a
 * recipient-scope policy (`recipient_account_id = auth.uid()` plus the epoch
 * guard) with SELECT and UPDATE granted to `authenticated`, so this file performs
 * no ownership checks of its own — the `.eq('recipient_account_id', ...)` filters
 * below are for efficiency and clarity, not security. A client cannot read or
 * acknowledge another account's notification even if it asks to.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

import type { AccountId, NotificationId, Timestamp } from '../domain/common.js';
import type {
  NotificationCategory,
  NotificationSettings,
} from '../domain/notification.js';
import type { ChannelStatus } from '../sync/connectivity.js';
import type { NotificationPorts, NotificationRow } from './notification-module.js';

/** Columns the module needs from a notification row. */
const NOTIFICATION_COLUMNS =
  'id, recipient_account_id, category, payload, created_at, dedupe_key, acknowledged_at, delivered_at';

/**
 * Build {@link NotificationPorts} over an authenticated Supabase client.
 *
 * `client` must carry the recipient's session — RLS derives the recipient from
 * `auth.uid()`, so an anonymous client sees nothing and a service-role client
 * would bypass the recipient scope entirely.
 */
export function createSupabaseNotificationPorts(client: SupabaseClient): NotificationPorts {
  return {
    subscribeRecipient(accountId, handlers): () => void {
      // Per-account channel carrying INSERTs only: an acknowledgement is an
      // UPDATE this client just made itself, so echoing it back would be noise.
      const channel: RealtimeChannel = client.channel(`notifications:${accountId}`);

      channel.on(
        // The string literal is required by supabase-js's overload; the enum
        // member is not usable from a type-only import.
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_account_id=eq.${accountId}`,
        } as never,
        (payload: { new?: NotificationRow }) => {
          if (payload.new !== undefined) {
            handlers.onInsert(payload.new);
          }
        },
      );

      channel.subscribe((status: string) => {
        handlers.onStatus(status as ChannelStatus);
      });

      return () => {
        void client.removeChannel(channel);
      };
    },

    async fetchAll(accountId): Promise<readonly NotificationRow[]> {
      const { data, error } = await client
        .from('notifications')
        .select(NOTIFICATION_COLUMNS)
        .eq('recipient_account_id', accountId);

      // A read failure is reported as "nothing to show" rather than thrown: a
      // notification list is ambient UI, and per design.md's error-handling table
      // a transient failure here must not surface as a hard error.
      if (error) return [];
      return (data ?? []) as unknown as NotificationRow[];
    },

    async fetchSettings(accountId): Promise<NotificationSettings | null> {
      const { data, error } = await client
        .from('notification_settings')
        .select('account_id, disabled_categories, expo_push_token')
        .eq('account_id', accountId)
        .maybeSingle();

      if (error || data === null) return null;

      const row = data as {
        account_id: string;
        disabled_categories: string[] | null;
        expo_push_token: string | null;
      };
      const token = row.expo_push_token;
      return {
        accountId: row.account_id as AccountId,
        disabledCategories: (row.disabled_categories ?? []) as NotificationCategory[],
        ...(token === null ? {} : { expoPushToken: token }),
      };
    },

    async acknowledge(id: NotificationId, at: Timestamp): Promise<NotificationRow | null> {
      const iso = new Date(at).toISOString();
      // Acknowledged AND delivered in one write: Req 11.6 says acknowledging
      // marks it delivered, and splitting them would leave a window where a
      // notification is acknowledged but still counted as undelivered.
      //
      // `acknowledged_at is null` makes this idempotent — a second acknowledge
      // matches no row and returns null rather than overwriting the original
      // timestamp with a later one.
      const { data, error } = await client
        .from('notifications')
        .update({ acknowledged_at: iso, delivered_at: iso })
        .eq('id', id)
        .is('acknowledged_at', null)
        .select(NOTIFICATION_COLUMNS)
        .maybeSingle();

      if (error || data === null) return null;
      return data as unknown as NotificationRow;
    },

    now: () => Date.now(),
  };
}
