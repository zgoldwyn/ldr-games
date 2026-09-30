# Ember & Tide game server

Local-first Colyseus 0.18 server for the authoritative two-player platformer.
No Colyseus account is needed to build, run, or test it locally. A cloud account
is only needed if the project is later deployed to Colyseus Cloud.

## Run locally

From the repository root:

```bash
npm install
cp apps/game-server/.env.example apps/game-server/.env
set -a
source apps/game-server/.env
set +a
npm run game-server:dev
```

The default endpoint is `http://127.0.0.1:2567`. Both the iPhone 17 and iPhone 17
Pro simulator instances on the same Mac can use that address at the same time;
each consumes its own seat reservation. A physical phone must use the Mac's LAN
address. Point Expo at it with:

```env
EXPO_PUBLIC_GAME_SERVER_URL=http://127.0.0.1:2567
```

`GET /health` is always available. Local session creation is deliberately
disabled unless `GAME_SERVER_ENABLE_DEV_ADMISSION=true` and a non-empty
`GAME_SERVER_DEV_ADMISSION_KEY` are supplied. It refuses to start with that
route enabled when `NODE_ENV=production`.

## Local-only session provisioning

The temporary endpoint below models the trusted Supabase session-start flow. It
creates one private room, fixes the creator's chosen role, assigns the linked
account the opposite role, and returns the creator's Colyseus seat reservation:

```bash
curl -X POST http://127.0.0.1:2567/dev/platformer-sessions \
  -H 'content-type: application/json' \
  -H 'x-dev-admission-key: replace-with-a-local-secret' \
  -d '{
    "gameSessionId":"local-game-1",
    "pairingId":"local-pairing-1",
    "creatorAccountId":"alice",
    "linkedAccountId":"bob",
    "creatorRole":"ember",
    "catalogFingerprint":"<fingerprint-from-health>"
  }'
```

The create response contains only the creator's reservation. The linked app
discovers its opposite-role reservation with its real pairing/account IDs:

```bash
curl -X POST http://127.0.0.1:2567/dev/platformer-sessions/claim \
  -H 'content-type: application/json' \
  -H 'x-dev-admission-key: replace-with-a-local-secret' \
  -d '{"pairingId":"local-pairing-1","accountId":"bob","catalogFingerprint":"<fingerprint-from-health>"}'
```

Each app consumes its own returned reservation with the Colyseus SDK's
`consumeSeatReservation()`. Do not use `joinOrCreate()` for this room. The dev
routes and their in-memory mapping are not production authentication. The next
security phase replaces them with the documented Supabase function, durable
session-to-room mapping, and 60-second signed single-use admission tickets.

Local couple progress is server-authoritative. Advancing a completed level saves
the next level in `apps/game-server/data/platformer-progress.json`; the raw pairing
identifier is SHA-256 hashed, the file is permission-restricted and gitignored,
and writes use an atomic rename. A catalog fingerprint change invalidates the
file's old progress so edited or reordered levels restart safely at Level 1.
Clients cannot choose a start level or advance to an arbitrary level.

`GET /health` publishes the server's authoritative
`platformerCatalogFingerprint`. Every create, status, and seat-claim request must
send the fingerprint bundled with that client. The server returns HTTP 409 before
creating or reserving a room when they differ, and successful responses echo the
authoritative fingerprint for the client to verify. After pushing a level from
the builder, wait for the core rebuild and game-server restart, then reload Metro
on each device before starting the next match.

## Two-simulator test

Use the same `EXPO_PUBLIC_GAME_SERVER_URL` and local admission key for both
simulators. Sign into the app as the two accounts in one real Supabase pairing.
On one simulator choose a role and tap **Create game**. On the other tap **Join
partner's game**. The creator waits in the room until the partner consumes the
opposite-role reservation. Setup shows a bounded connection/wait state and the
room shows connecting, waiting, reconnecting, or Retry/Back failure UX.

In a second terminal, load the Expo variables before starting Metro:

```bash
set -a
source apps/mobile/.env
set +a
npm run start --workspace @ldr/mobile
```

Copy `apps/mobile/.env.example` to `apps/mobile/.env` first, and make its
`EXPO_PUBLIC_GAME_SERVER_DEV_ADMISSION_KEY` exactly match the server's
`GAME_SERVER_DEV_ADMISSION_KEY`.

## Simulation contract

- One authoritative fixed input step at 30 Hz.
- Two physics substeps per input step (60 Hz integration).
- State patches every 33 ms (about 30 Hz).
- Client sends input, never position.
- `stepPlatformerPlayer` is the shared deterministic movement kernel intended
  for both server authority and client prediction/reconciliation.

Run focused checks with `npm run game-server:test`, or include the server in the
repository-wide `npm run typecheck` and `npm run lint` commands.
