/**
 * Game module barrel — the client service modules over the already-tested
 * real-time and asynchronous game Edge Functions (task 21.2).
 *
 * The rules themselves live in `domain/` and are shared with the server:
 * `rt-engine.ts` + `rt-tic-tac-toe.ts` for real-time moves, `async-engine.ts` +
 * `async-battleship.ts` for turns. This directory holds the client wiring over
 * them, caching each session in the Local Store for instant and offline reads.
 *
 * Channels are NOT opened here: the Connection Manager (task 21.3) owns the
 * Broadcast and Postgres Changes subscriptions and feeds arriving state in via
 * `applyRemoteState` / `applyRemoteRow`.
 */
export * from './rt-game-module.js';
export * from './async-game-module.js';
export * from './supabase-ports.js';
