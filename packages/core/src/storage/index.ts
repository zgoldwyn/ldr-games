/**
 * Storage barrel — pairing-scoped binary content.
 *
 * Currently the private `drawings` bucket backing the asynchronous drawing game
 * (Req 7.3): the pure object-key rules that the Storage RLS policies authorize
 * on, and the `supabase-js` adapter that uploads and signs reads.
 */
export * from './drawing-images.js';
export * from './drawing-store.js';
