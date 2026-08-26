# Edge Functions (Deno)

Server-authoritative logic for the LDR Companion App runs here as Supabase Edge
Functions (Deno / TypeScript). These functions run with the service role and are
the only path allowed to perform sensitive writes and state transitions
(registration, login epoch hook, pairing accept/unlink, sync write-path with
HLC conflict resolution, real-time/async game move validation, quiz scoring, and
the pg_cron-invoked scheduler jobs). See `design.md` for the full mapping.

## Layout

```
supabase/functions/
  deno.json        # shared Deno project config + import map for all functions
  _shared/         # shared infrastructure helpers (CORS, etc.) — not domain logic
  health/          # health-check skeleton used to verify the edge runtime works
```

- Each function lives in its own folder with an `index.ts` entry point.
- `_shared/` holds cross-function infrastructure utilities. Pure domain logic is
  imported from the shared `@ldr/core` package rather than duplicated here.
- Function-specific auth behavior (`verify_jwt`) is configured per function under
  `[functions.<name>]` in `supabase/config.toml`.

## Running locally

Requires Docker Desktop (for `supabase start`) and the Deno-backed edge runtime,
both provided by the Supabase CLI (installed as a dev dependency).

```bash
npm run supabase:start        # boots the local stack (Postgres, Auth, Realtime, Storage, Edge Runtime)
npm run supabase:functions    # serves functions with hot reload
curl http://127.0.0.1:54321/functions/v1/health
npm run supabase:stop
```
