/**
 * @ldr/core — shared TypeScript domain logic, service modules, and theme tokens
 * consumed identically by the mobile (Expo) and desktop (Electron/web) shells.
 *
 * This entry point exposes the theme token system (Req 5.1), the `Result` type
 * and its constructors/guards, the machine-readable error vocabulary, and the
 * shared domain entity/value types. Behavioral domain modules (auth, pairing,
 * sync, games, quizzes, calendar, notifications) are added in subsequent tasks.
 */
export * from './theme/index.js';
export * from './result.js';
export * from './errors.js';
export * from './domain/index.js';
export * from './auth/index.js';
export * from './sync/index.js';
export * from './store/index.js';
export * from './games/index.js';
export * from './connection/index.js';
export * from './storage/index.js';
export * from './notifications/index.js';

/** Package metadata, useful for shells to display/version-check the shared core. */
export const CORE_PACKAGE_NAME = '@ldr/core';
