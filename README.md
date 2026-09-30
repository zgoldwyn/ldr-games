# LDR Companion App

Cross-platform (mobile + desktop) companion app for people in long-distance
relationships. Two people link their accounts into an exclusive one-to-one
pairing and share real-time and turn-based games, themed quizzes, and a calendar
of important dates with reminders.

Built on [Supabase](https://supabase.com) (Postgres + RLS, Auth, Realtime,
Storage, Edge Functions, pg_cron) with a shared TypeScript core wrapped by an
Expo mobile shell and an Electron/web desktop shell.

Pre-release legal and trust work is tracked in the
[Legal, Privacy, Accessibility, and Trust Action Plan](docs/legal-accessibility-action-plan.md).
Current policy drafts are available in `docs/` and in the mobile app's Legal &
privacy screen. Operator identity and launch-territory details must be completed
and reviewed by qualified counsel before public release.

## Status

**The backend is implemented and verified against local and hosted Supabase
stacks, and the iOS MVP shell is wired end to end.** The mobile app supports
account creation/sign-in, pairing, tic-tac-toe, Battleship, Draw Together,
Speed, the first live Word Chain game, Couples Quiz, notification reads,
settings, account deletion, and the first UI/legal-accessibility pass. Play now
groups card games, word games, other minigames, and an early online movement
prototype for the cooperative platformer **Ember & Tide**.

| Area                                                                                        | State                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Pure domain logic (validation, HLC, game engines, quiz scoring, dates, reminders, delivery) | Done — broad unit and property-test coverage                 |
| Schema, RLS, Storage policies                                                               | Done                                                         |
| Auth, pairing, sync, real-time games, async games, Storage wiring                           | Done — Edge Functions + integration tests                    |
| Game scheduler (join expiry, pause termination, turn nudge)                                 | Done — pg_cron                                               |
| In-app notification reads                                                                   | Done                                                         |
| Client service modules, Connection Manager                                                  | Done for MVP                                                 |
| Expo mobile shell                                                                           | Done for MVP; UI polish in progress                          |
| Card games                                                                                  | Speed is playable; additional tables planned                 |
| Word games                                                                                  | Live Word Chain slice implemented; more modes planned        |
| Couples Quiz                                                                                | Mobile experience complete; live-stack verification pending  |
| Ember & Tide cooperative platformer                                                         | Local Colyseus authority + immutable online roles scaffolded |
| Calendar, reminders, and desktop shell                                                      | Deferred — see MVP scope below                               |

The spec lives in [`.kiro/specs/ldr-companion-app/`](.kiro/specs/ldr-companion-app/)
(`requirements.md`, `design.md`, `tasks.md`). `tasks.md` is the source of truth
for what is done, what is deferred, and **what each deferral costs**.

### MVP scope

The remaining work is split into an MVP path and deferred sections, marked
`[MVP]` and `[DEFERRED]` in `tasks.md`. The MVP is:

> sign in on an iPhone, pair with a partner, and play one real-time game
> (tic-tac-toe) and one asynchronous game (battleship)

That baseline is implemented. Current work is focused on game expansion,
live-stack verification, device testing, and UI polish rather than completing
the original client shell.

Two honest caveats about the MVP:

- **Deferring the desktop shell means Requirement 5.1 is not satisfied**, since
  5.1 explicitly requires the same data on mobile _and_ desktop. That is a real
  reduction in scope, not a reordering.
- **A phone cannot reach a service bound only to `127.0.0.1`.** The simulator
  can use localhost, but physical-device testing of a local Supabase or game
  server needs the Mac's LAN address or a hosted endpoint.

## Monorepo layout

[npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) monorepo.
Shared logic lives in a single TypeScript core consumed identically by both
shells so the experience matches across devices (Requirement 5.1).

```
.
├── packages/core/src/
│   ├── domain/          # pure, property-tested domain logic (no I/O)
│   ├── sync/            # offline queue, connectivity state, Postgres Changes
│   ├── storage/         # drawing-image object keys + Storage adapter
│   ├── notifications/   # in-app notification reads + acknowledgement
│   ├── theme/           # swappable pastel theme tokens (default: pink)
│   └── __harness__/     # integration-test harness and suites
├── apps/
│   ├── mobile/          # @ldr/mobile — Expo/React Native iOS + Android app
│   ├── game-server/     # @ldr/game-server — authoritative Colyseus platformer
│   └── desktop/         # @ldr/desktop — Electron/web shell (stub)
├── supabase/
│   ├── migrations/      # SQL schema, RLS, RPCs, games, profiles, and cron
│   └── functions/       # Deno Edge Functions + shared request/runtime code
├── docs/
│   ├── live-platformer-architecture.md # Ember & Tide networking plan
│   └── word-games-roadmap.md            # Word-game product and architecture plan
├── scripts/
│   └── with-supabase-env.sh   # exports local stack URL + keys for integration runs
├── vitest.workspace.ts  # unit / property / integration projects
└── tsconfig.json        # solution file (project references)
```

TypeScript [project references](https://www.typescriptlang.org/docs/handbook/project-references.html)
wire the packages together, so `tsc --build` compiles in dependency order.

### Architectural conventions worth knowing

- **Pure logic first.** Anything with a decision in it lives in
  `packages/core/src/domain/` as a pure function taking an explicit `now`, and is
  property-tested with `fast-check`. Edge Functions and clients are thin I/O
  around that shared logic, so one property test covers both sides.
- **`Result<T, E>` at boundaries**, never thrown exceptions for control flow.
  Errors carry a stable machine-readable code.
- **RLS is the primary authorization mechanism.** Clients read and write through
  RLS-filtered access as the `authenticated` role. Server-authoritative
  transitions (moves, turns, pairing acceptance, unlink, conflict resolution) go
  through Edge Functions using the service role.
- **Injected ports in client modules.** `sync/`, `storage/` and `notifications/`
  take narrow function-typed ports rather than a `SupabaseClient`, so the
  orchestration logic is unit-testable without a stack and the Connection Manager
  (task 21.3) can compose them rather than rewrite them.

## Getting started

```bash
npm install
npm run build
npm test          # unit + property tests; integration suites self-skip
```

Run the iOS development build in a booted simulator:

```bash
npm run ios --workspace @ldr/mobile
```

Build once and launch the app on two iPhone simulators for paired-user testing:

```bash
npm run ios:two
```

By default this uses the first two iPhones from the newest installed iOS
runtime. Pass two names or UDIDs after `--` to choose them explicitly; run
`npm run ios:two -- --list` to see the available choices.

The platformer has a local movement playground plus an initial authoritative
Colyseus server. The creator chooses Ember or Tide, the linked partner receives
the other character, and those roles remain fixed for that game. Local server
setup is in [`apps/game-server/README.md`](apps/game-server/README.md); the full
authentication bridge and hosting progression are documented in
[`docs/live-platformer-architecture.md`](docs/live-platformer-architecture.md).

Integration tests need a local Supabase stack, which needs **Docker**:

```bash
npm run supabase:start      # Postgres + Auth + Realtime + Storage
npm run supabase:functions   # Edge Functions runtime — a SEPARATE process
npm run test:integration:local
```

## Commands

Run from the repo root.

| Command                                        | Description                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `npm run verify`                               | **Everything**: build, lint, vitest, `deno check`, Deno tests |
| `npm run build`                                | Type-check and build every package (`tsc --build`)            |
| `npm run typecheck`                            | Force a full type-check across the workspace                  |
| `npm run lint` / `lint:fix`                    | Lint with ESLint                                              |
| `npm run format` / `format:check`              | Format with Prettier                                          |
| `npm test`                                     | All vitest suites (integration self-skips without keys)       |
| `npm run test:unit`                            | Example/edge-case tests only                                  |
| `npm run test:property`                        | `fast-check` property tests (min 100 iterations each)         |
| `npm run test:integration:local`               | Integration suites against the running local stack            |
| `npm run edge:check`                           | `deno check` every Edge Function                              |
| `npm run edge:test`                            | Deno unit tests for `supabase/functions/_shared/`             |
| `npm run edge:lint` / `edge:fmt:check`         | Deno lint / format check                                      |
| `npm run supabase:start` / `stop` / `status`   | Local stack lifecycle                                         |
| `npm run supabase:functions`                   | Serve Edge Functions locally                                  |
| `npm run game-server:dev`                      | Run local Colyseus on port 2567                               |
| `npm run game-server:test`                     | Run focused platformer-server unit tests                      |
| `npm run ios:two`                              | Build once and launch on two iPhone simulators                |
| `npm run ios --workspace @ldr/mobile`          | Build, install, and launch the iOS development app            |
| `npm run bundle:check --workspace @ldr/mobile` | Produce an iOS Expo bundle as a packaging smoke test          |

`npm run verify` is the one to run before committing. Note it does **not**
include integration tests, because those need Docker.

## Testing

Four suites, split by filename convention (see `vitest.workspace.ts`):

| Pattern                           | Project       | Covers                                                              |
| --------------------------------- | ------------- | ------------------------------------------------------------------- |
| `*.test.ts`                       | `unit`        | specific examples and edge cases                                    |
| `*.property.test.ts`              | `property`    | universal properties via `fast-check`                               |
| `*.integration.test.ts`           | `integration` | a live Supabase stack: RLS, Edge Functions, Realtime, Storage, cron |
| `supabase/functions/**/*.test.ts` | Deno          | Edge Function wiring (`npm run edge:test`)                          |

Property tests are tagged in-source with
`// Feature: ldr-companion-app, Property {n}: {text}` for traceability against
the 44 correctness properties in `design.md`.

There are integration suites for authentication, account profiles and deletion,
pairing, sync, real-time and asynchronous games, Draw Together, quizzes,
calendar, drawing storage, notifications, scheduling, RLS, and the harness
itself.

### Integration tests self-skip

Every `*.integration.test.ts` calls `getIntegrationConfig()` and **skips itself**
when `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are absent. That keeps
`npm test` green without Docker — but it also means a plain
`npm run test:integration` proves nothing. Use `test:integration:local`, which
reads the keys from `supabase status` via `scripts/with-supabase-env.sh`.

### Mutation-check security properties

A passing test is not evidence that the mechanism it names is doing the work.
Break the mechanism, confirm the test fails, then restore:

```bash
docker exec -i supabase_db_ldr-games psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 < /tmp/mutation.sql
npm run test:integration:local     # the relevant test MUST fail
npx supabase db reset              # restore
```

This has repeatedly earned its keep. It found that a concurrency test passed with
every database guard removed (an Edge Function's pure pre-check was masking the
race), and that an RLS scoping test passed with the policy flattened to
`using (true)` (a client-side `.eq()` filter was masking it). **To test a
database-level invariant, drive the RPC or table directly** so no application
layer can stand in for it.

Two traps: `create or replace function` cannot remove parameter defaults, so a
mutation can silently fail to apply — pipe SQL from a file with
`-v ON_ERROR_STOP=1`. And a mutation is only evidence when it produces a
**failure**; if everything still passes, suspect the mutation before the code.

## Gotchas

- **The Edge Functions runtime is a separate process** from the database.
  `supabase start` does not serve functions; `supabase functions serve` does.
  Integration suites that call a function need both.
- **Build before editing the Edge Function import map.** Adding an `@ldr/core/*`
  entry to `supabase/functions/deno.json` before `npm run build` has emitted the
  corresponding `dist` file crashes the functions runtime, and every function
  then returns 503 until you restart it.
- **Integration suites must run serially.** They share one stack, and in parallel
  they contend for the same Postgres, Realtime and edge runtime, turning latency
  assertions into contention measurements. The `test:integration*` scripts pass
  `--no-file-parallelism`; note that setting `fileParallelism` inside a vitest
  workspace _project_ is a silent no-op.
- **The first Realtime subscription after `supabase db reset` is dead.** It
  reports `SUBSCRIBED` and then never delivers, while a freshly created
  subscription works immediately — so waiting longer cannot help. Latency-
  sensitive suites use the harness's `withRealtimeRetry` to re-subscribe.
- **`deno` is a pinned devDependency**, not a global. `supabase/functions` is
  excluded from ESLint, Prettier, tsconfig and vitest on purpose; it is checked by
  Deno's own tooling via the `edge:*` scripts.

## Theme

The UI uses a soft pastel, minimalist style driven by semantic design tokens in
`packages/core/src/theme/`, so both shells render identically. Colour options are
swappable (`pink` is the default) and components reference tokens by role
(`background`, `surface`, `primary`, `textPrimary`, …) rather than hex values.
See `.kiro/steering/theme.md`.
