// HLC surface used by the sync write path (Requirements 5.5, 5.6).
//
// The conflict-resolution logic is NOT reimplemented here: `compareHLC` and
// `resolveConflict` come from the built `@ldr/core` module
// (`packages/core/src/domain/hlc.ts`), which is pure and dependency-free, so the
// server-side write path and the clients run byte-identical logic and the
// property test for Property 18 covers both.
//
// The shared sync SHAPES are likewise re-exported rather than restated. Deno
// resolves the declarations that `tsc --build` emits next to the compiled `.js`
// (see the `sloppy-imports` note in `supabase/functions/README.md`), so this
// module can hand the edge functions core's own `DataChange` / `HLCTimestamp`
// — brands and all — instead of a structurally-similar copy that would silently
// diverge.

export {
  compareHLC,
  resolveConflict,
} from "@ldr/core/hlc";

export type {
  AppliedChange,
  DataChange,
  HLCTimestamp,
  SharedItemType,
} from "@ldr/core/sync";

export type { AccountId, Timestamp } from "@ldr/core/common";

// Brand casts for handing raw uuids/text from Postgres to the branded domain
// signatures. These are pure compile-time casts.
export { accountId } from "@ldr/core/common";
