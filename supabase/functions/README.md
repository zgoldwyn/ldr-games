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
  _shared/         # shared infrastructure helpers (CORS, clients, HTTP, Realtime) — not domain logic
  health/          # health-check skeleton used to verify the edge runtime works
  auth-login/      # single-session login: verify creds, bump epoch, revoke prior client
```

### Single-session enforcement (auth-login)

`auth-login` is the server-authoritative sign-in path (Req 2.7-2.9). On a valid
credential check it increments the account's `account_session.epoch` (via the
`public.bump_session_epoch` RPC), broadcasts a `revoke` on the per-account
Realtime channel `account:{id}` to displace any prior client, and returns a
freshly minted token whose `epoch` claim is embedded by the `custom_access_token`
auth hook (`app.custom_access_token`, migration `20260826062551`). The epoch
guard `app.session_epoch_ok` (migration `20260826062549`) then rejects any
request bearing a stale epoch. All credential failures return a uniform,
non-revealing error (Req 2.2).

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
