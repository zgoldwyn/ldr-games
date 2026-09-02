/**
 * Sync module barrel — synchronization behavior shared by both client shells
 * and (where noted) the write-path Edge Function.
 *
 * Exposes the offline sync queue (Req 5.4), the connectivity state machine that
 * drives the connectivity-lost indicator (Req 5.4), and the client Sync Module
 * that subscribes to pairing-scoped Postgres Changes (Req 5.3) and drains the
 * queue on reconnection (Req 5.5). Conflict resolution itself lives in
 * `domain/hlc.ts` and is applied server-side by the `sync-write` Edge Function.
 */
export * from './queue.js';
export * from './connectivity.js';
export * from './sync-module.js';
export * from './supabase-ports.js';
