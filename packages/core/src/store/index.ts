/**
 * Local Store barrel — the client-side cache of shared state (task 21.2).
 *
 * Persistence is the shell's job: `snapshot`/`hydrate` expose the whole cache so
 * a platform can write it to AsyncStorage or disk (task 22.1b).
 */
export * from './local-store.js';
