/**
 * Notification module barrel — in-app notification reads and acknowledgement
 * (Req 11.1, 11.2, 11.3, 11.4, 11.6).
 *
 * The eligibility rules themselves (`shouldDeliver`, `isExpired`, dedupe) live in
 * `domain/notification-delivery.ts` and are shared with the server. This
 * directory holds the client wiring over them. Out-of-app push (task 19.2) and
 * the settings write path (19.1b) are deferred.
 */
export * from './notification-module.js';
export * from './supabase-ports.js';
