/**
 * Auth and pairing module barrel — the client service modules over the
 * already-tested authentication and pairing Edge Functions (task 21.1).
 *
 * The rules themselves live elsewhere and are shared with the server: credential
 * policy in `domain/auth-validation.ts`, session validity in
 * `domain/session-epoch.ts`, and the pairing decisions in
 * `domain/pairing-logic.ts`. This directory holds the client wiring over them.
 */
export * from './auth-module.js';
export * from './pairing-module.js';
export * from './supabase-ports.js';
