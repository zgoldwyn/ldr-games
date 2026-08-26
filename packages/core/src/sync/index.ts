/**
 * Sync module barrel — synchronization behavior shared by both client shells
 * and (where noted) the write-path Edge Function. Currently exposes the offline
 * sync queue (Req 5.4); the HLC clock and conflict resolution are added by their
 * own tasks.
 */
export * from './queue.js';
