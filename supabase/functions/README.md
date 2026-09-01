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
  rt-presence/     # real-time games: Presence-driven 30s disconnect -> pause + notify
  rt-rejoin/       # real-time games: resume from preserved state within 5 min
```

### Real-time pause / rejoin (rt-presence, rt-rejoin)

`rt-presence` receives the Presence snapshot from a game channel and is the
authority on the 30-second disconnect rule (Req 6.6): it pauses the
`rt_sessions` row (`active -> paused`, stamping `paused_since`) without touching
`game_state`, so the state is preserved, records a notification for the
remaining partner, and broadcasts `paused` on `rt_session:{id}`.

`rt-rejoin` resumes a paused session (`paused -> active`) when the disconnected
partner returns within 5 minutes, again leaving `game_state` untouched so both
partners resume from identical preserved state (Req 6.7); a later rejoin is
rejected with `REJOIN_WINDOW_EXPIRED`. Both functions present the recorded
outcome instead of an error once the session is terminal (Req 6.8).

The decisions come from pure code: the 30s evaluation in
`_shared/rt-presence.ts` and the `pauseSession` / `resumeSession` transitions in
`@ldr/core/rt-session`. Terminating a pause that is never rejoined belongs to the
5-minute cron job (task 20.1).

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
