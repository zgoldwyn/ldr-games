/**
 * Connection Manager barrel — Realtime channels, reconnect, and displacement
 * sign-out (task 21.3).
 *
 * `connection-manager.ts` composes the task 14.2 sync module rather than
 * reimplementing it, and adds what 14.2 left out: the per-account Broadcast
 * channel, the per-session game channel, Presence tracking, and the revoke that
 * forces a local sign-out. `presence.ts` holds the pure roster folding that
 * decides when `rt-presence` should be called (Req 6.6).
 */
export * from './presence.js';
export * from './connection-manager.js';
export * from './supabase-ports.js';
