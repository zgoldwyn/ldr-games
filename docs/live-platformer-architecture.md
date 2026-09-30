# Live Cooperative Platformer — Architecture Decision

**Status:** Final — approved for implementation
**Working concept:** A two-player cooperative elemental platformer inspired by
games where each character has different environmental abilities.

This document is the source of truth for implementing the live platformer. The
choices below are decisions, not options to revisit during initial development,
unless testing produces concrete evidence that a change is required.

## Chosen stack

- Build the live match server with open-source **Colyseus** and TypeScript.
- Add it to this monorepo as `apps/game-server`.
- Use Colyseus **0.18 or newer** and the official `@colyseus/sdk` client from
  the Expo app so the implementation can use Colyseus's prediction and
  reconciliation primitives.
- Keep **Supabase** for accounts, pairing, invitations, durable progress,
  achievements, checkpoints, and final match results.
- Use **Colyseus rooms**, rather than Supabase Realtime Broadcast or database
  writes, for live movement, physics, collision, switches, hazards, and level
  state.
- Do not replace Supabase authentication or the existing pairing model with a
  second account system.

### Client scope and public configuration

This repository currently contains an Expo mobile client and an Electron/web
desktop stub. It does **not** contain a Next.js application. The first playable
slice targets Expo, so its public endpoint is correctly named:

```env
EXPO_PUBLIC_GAME_SERVER_URL=http://127.0.0.1:2567
```

If a Next.js client is added later, it must expose the same logical setting as
`NEXT_PUBLIC_GAME_SERVER_URL`. Framework-specific environment-variable names
must be adapted at the shell boundary; shared modules receive an already parsed
game-server URL and must not read either variable directly.

## Hosting progression

### 1. Local development first

Run Colyseus locally on port `2567` while building the first level.

- iOS simulators on the same Mac use `http://127.0.0.1:2567`.
- Physical devices on the same LAN use the Mac's LAN address.
- Keep the endpoint behind one configuration value:

```env
EXPO_PUBLIC_GAME_SERVER_URL=http://127.0.0.1:2567
```

The client must not contain provider-specific deployment logic. Migrating later
must require changing the endpoint, not rewriting the room protocol.

### 2. Free remote testing on Render

When both partners need to test from different networks, deploy the same
Colyseus Node application as a free Render Web Service.

- Use Render's HTTPS endpoint; the Colyseus SDK upgrades it to secure WebSockets.
- Expect the free service to sleep after 15 minutes with no inbound HTTP traffic
  or WebSocket messages. Show an explicit `Waking game server…` state because
  the first connection can take about one minute to start it.
- Normal active-match WebSocket messages prevent idle spin-down. Do not send
  artificial gameplay traffic solely to keep the free instance awake.
- Use normal ping/pong keepalives to detect dead connections and implement
  reconnects; keepalives are connection health checks, not fake activity.
- Treat Render Free as a prototype environment: restarts, cold starts, and
  single-instance availability are acceptable during testing. A free service
  can restart unexpectedly and cannot scale beyond one instance.
- Do not store durable match data on Render's local filesystem.

Production configuration will look like:

```env
EXPO_PUBLIC_GAME_SERVER_URL=https://ldr-game-server.onrender.com
```

### 3. Paid production hosting only when justified

Move the unchanged Colyseus server to **Colyseus Cloud** when any of these become
true:

- the game is released to real users;
- Render cold starts materially harm joining;
- uptime or graceful room draining becomes a release requirement;
- more regions are needed for acceptable latency; or
- concurrency exceeds what one free instance can safely handle.

Do not pay for Colyseus Cloud before one of these triggers is reached.

### Desktop-hosting boundary

Running Colyseus on a personal desktop is allowed for local development and
same-Wi-Fi demos only. It is not the remote-test or production plan. Do not make
the home network publicly reachable with router port forwarding. Keeping a
desktop awake, securing it, maintaining TLS, handling dynamic IP changes, and
recovering from home internet outages are unnecessary operational risks when a
free hosted prototype is available.

## Live networking model

- The Colyseus room owns the authoritative match state.
- Use Colyseus 0.18+ netcode primitives: `room.input()` for sequenced inputs,
  `Predict.reconciler()` for local prediction and authoritative reconciliation,
  and Colyseus remote interpolation for other players and moving world objects.
  Do not build a parallel custom sequencing, acknowledgement, rollback, or
  replay layer unless a documented limitation is demonstrated in testing.
- Clients send **input state** (`left`, `right`, `jump`, interaction), not a
  database write or full position for every rendered frame.
- Sample and submit inputs at **30 Hz**.
- Run the authoritative server simulation with
  `setFixedTimestep(..., 30)` and **two physics substeps**, producing a 60 Hz
  physics integration rate.
- Keep state synchronization separate from simulation: begin with a Colyseus
  `patchRate` of **50 ms**, or 20 authoritative state patches per second.
- Treat input rate, simulation rate, physics substeps, and patch rate as four
  separate tuning values. Changing one must not silently change the others.
- Render locally at the device frame rate.
- Predict the local player's movement immediately and reconcile it through the
  Colyseus input acknowledgement and rollback/replay path.
- Interpolate (lerp) remote players and moving world objects between 20 Hz state
  patches.
- Never run React state updates once per animation or physics frame. Rendering
  state belongs in the game/render loop or UI-thread values.
- Supabase Realtime may still deliver account-level invitations, but it is not
  the live physics transport.
- Postgres must never receive per-frame movement or collision writes.

## Session-to-room mapping

One Supabase platformer game session maps to exactly one private Colyseus room.
This is a hard invariant.

- Store the assigned `colyseus_room_id` against the durable Supabase game
  session.
- Create the room from trusted server code and make creation idempotent by game
  session id. A uniqueness constraint must prevent two concurrent starts from
  creating two rooms for the same session.
- Disable arbitrary client-side creation of platformer rooms. The mobile client
  must never use an unrestricted `joinOrCreate("platformer")` flow.
- Use a private room with exactly two seats. The trusted session-start flow
  creates server-side seat reservations for the two paired accounts.
- A client may join only the room id mapped to the `gameSessionId` in its
  validated admission ticket.
- The creator chooses `ember` or `tide` as part of the trusted session-creation
  request. The linked partner receives the opposite role.
- Persist both account-to-role assignments on the durable game session when it
  is created. They are immutable for the lifetime of that session: neither
  player may swap roles, and reconnecting never recalculates them.
- The client may request the creator's initial choice, but it cannot submit or
  override a role while joining a Colyseus room. The room trusts only the
  persisted assignment returned by the admission flow.
- When the room ends, persist the final result once and close the mapping so a
  later session cannot reuse an old room.

## Authentication bridge

The mobile client must not be allowed to join an arbitrary room by submitting a
pairing or account id that it chose itself.

1. A paired user chooses Ember or Tide and starts a platformer session through
   Supabase.
2. A Supabase Edge Function validates the authenticated creator, pairing, and
   requested role, then atomically stores the creator on that role and the
   linked account on the opposite role.
3. It creates or retrieves the one private Colyseus room mapped to that game
   session and reserves the caller's persisted seat and role.
4. It returns a signed admission ticket containing `userId`, `gameSessionId`,
   `pairingId`, assigned `role`, `iat`, `exp`, `aud`, and a unique ticket id
   (`jti`/nonce), plus the mapped Colyseus room id.
5. The ticket audience identifies this game server and its join lifetime is
   initially **60 seconds**. It is an admission credential, not a match-lifetime
   credential; an established WebSocket is not disconnected merely because the
   admission ticket expires.
6. The Colyseus room validates the signature, audience, expiry, nonce, session,
   room mapping, seat, and role in `onAuth` before `onJoin` runs.
7. The `jti` is single-use and is consumed atomically during `onAuth`. A failed
   or disconnected client requests a newly issued ticket before reconnecting.
   A ticket for another room, session, role, or audience is rejected.
8. The room accepts exactly the two accounts belonging to that session.

Secrets used to sign or validate tickets stay server-side. They are never placed
in an `EXPO_PUBLIC_*` variable.

## Durability and recovery

- Active room state lives in Colyseus memory for responsiveness.
- Persist only coarse checkpoints at meaningful boundaries such as a checkpoint,
  level completion, or explicit room shutdown.
- Write final completion time, collectibles, result, and achievements to
  Supabase exactly once using an idempotency key.
- A reconnecting client receives the current full Colyseus room state and then
  resumes delta updates.
- If the prototype host restarts and no checkpoint can restore the room, explain
  that the test match ended; do not fabricate progress.

## Initial implementation order

1. Scaffold `apps/game-server` as a TypeScript Colyseus workspace.
2. Add environment-aware game-server configuration to the Expo app.
3. Implement immutable creator-selected role assignment, the idempotent
   one-Supabase-session-to-one-private-Colyseus-room mapping, and two
   server-created seat reservations.
4. Implement the 60-second signed Supabase-to-Colyseus admission ticket and
   strict Colyseus `onAuth` validation.
5. Create one two-player room with a 30 Hz deterministic fixed step, two physics
   substeps, and a 50 ms patch rate.
6. Integrate Colyseus 0.18+ client prediction/reconciliation, remote
   interpolation, input sequencing/acknowledgement, and reconnect behavior.
7. Build one small test level containing character-specific hazards, one shared
   switch puzzle, one checkpoint, and a cooperative exit.
8. Verify the level on the open iPhone 17 and iPhone 17 Pro simulators.
9. Deploy the server to Render Free only when testing across separate networks
   is needed.

## Acceptance criteria for the first playable slice

- One Supabase game session creates exactly one private two-seat Colyseus room.
- Its creator receives the role chosen at session creation, the linked partner
  receives the opposite role, and both assignments remain unchanged through
  joins, reconnects, and the full match.
- Both players can move concurrently without waiting on Supabase requests.
- Local movement reacts immediately; remote movement remains smooth under
  ordinary network jitter.
- The implementation uses Colyseus input prediction/reconciliation and remote
  interpolation instead of maintaining a duplicate custom netcode stack.
- The server, not either client, decides collisions, deaths, switches,
  checkpoints, and level completion.
- Disconnect/reconnect restores the authoritative room state when the room is
  still alive.
- No live physics path writes to Postgres per frame.
- Changing `EXPO_PUBLIC_GAME_SERVER_URL` is sufficient to move between local,
  Render, and Colyseus Cloud endpoints.

## References

- [Colyseus documentation](https://docs.colyseus.io/)
- [Colyseus deployment guide](https://docs.colyseus.io/deployment)
- [Colyseus React Native-compatible TypeScript SDK](https://docs.colyseus.io/getting-started/typescript)
- [Render free-service behavior](https://render.com/docs/free)
- [Render WebSocket hosting](https://render.com/docs/websocket)
