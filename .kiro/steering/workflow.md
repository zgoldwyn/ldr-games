---
inclusion: always
---

# Spec-Driven Workflow

Work this repo from the Kiro spec, not from memory. The source of truth is `.kiro/specs/ldr-companion-app/`.

| File | Use it for |
|---|---|
| `requirements.md` | What must be true (acceptance criteria, glossary) |
| `design.md` | How it is built (architecture, modules, deviations) |
| `tasks.md` | What to do next, in order, with MVP vs deferred |

Also follow sibling steers: `theme.md` for UI, `commit-on-task-complete.md` for git, `decisions.md` for choices the spec does not settle.

## Product goal

Exclusive one-to-one pairing for a long-distance couple: shared real-time games, async games, quizzes, and a relationship calendar. Shared TypeScript core (`packages/core`) + Expo mobile + Electron/web desktop, backend on Supabase (Postgres/RLS, Auth, Realtime, Storage, Edge Functions, pg_cron).

**Current MVP (usable two-person app, not a public release):** sign in on iPhone, pair, play **tic-tac-toe** (real-time) and **battleship** (async). Desktop, quizzes, calendar, push, and category settings are deferred.

## Orient before coding

1. Read `tasks.md` Overview + MVP Scope + the **MVP Critical Path** at the bottom.
2. Find the next incomplete **leaf** task on that path. Do not invent a parallel track.
3. Open the `_Requirements:` lines on that task and the matching design section.
4. Prefer existing contracts over guessing: integration tests under `packages/core/src/__harness__/` and notes already on the task.

## Checkbox language

- `[x]` done. Do not redo it unless the user asks or tests prove it broken.
- `[ ]` open. This is eligible work if it is on the current path.
- `[-]` cancelled or left incomplete **on purpose**. Read the task note; the remaining work is usually owned by a later task (example: 15.2 server is done; client Presence is 21.3).
- Parent `[ ]` with all children `[x]` or `[-]` is bookkeeping, not a new task. Do not reopen the parent.
- `[MVP]` = on the path to a usable iOS app. `[DEFERRED, post-MVP]` = out of scope unless the user explicitly picks it up. Deferred is a real cut: iOS-only MVP does **not** satisfy Req 5.1.

## Current progress (re-check `tasks.md`; do not trust this if it disagrees)

Done: scaffolding (1), schema/RLS (2), all pure domain + property tests (3–11), auth/pairing/sync/game Edge wiring and their integration tests (12–16 except noted gaps), in-app notification reads (19.1a, 19.3), game cron jobs (20.1, 20.3).

**Next MVP sequence** (skip any already `[x]`):

1. `21.1` AuthenticationModule + PairingModule
2. `21.2` tic-tac-toe + battleship client modules + Local Store
3. `21.3` Connection Manager: Broadcast, Presence, revoke sign-out (compose 14.2; do not rewrite it)
4. `22.1a` real Expo app from the `apps/mobile` stub
5. `22.1b` MVP screens (auth, pairing, game list, both boards) using theme tokens
6. `23.1` wire those modules into the mobile shell end to end
7. `21B.1` hosted Supabase — **irreversible; get explicit confirmation before pushing migrations**

Then-to-submit (not needed to use a local/dev build): `21A.*` account deletion, then `22.1c` App Store extras.

Stay off unless asked: `17.x` quizzes, `18.x` calendar/reminders, `19.1b` category writes, `19.2` push, `20.2` reminder/inactivity/retention cron, `22.2`/`22.3` desktop + parity.

## How to execute one task

- One leaf task at a time. Do not batch 21.1–21.3 or “just start Expo” before the client modules exist.
- Test-driven where the plan already does: property tests in core (`fast-check`, ≥100 iterations, tag `// Feature: ldr-companion-app, Property {n}: {text}`); integration tests against the local stack for wiring.
- Domain logic stays pure and deterministic. Edge Functions and SQL are the authority; clients submit intents.
- Compose existing `packages/core` modules (sync, notifications, drawing store, domain helpers). Rewrite only if the task says to.
- Theme: semantic tokens from core, never hardcoded hex in components (`theme.md`).
- A phone cannot reach `127.0.0.1`. Local stack is for simulator/LAN; hosted project is `21B.1` only.
- After implementation and verification: mark the leaf `[x]` in `tasks.md`, then commit that task only (`commit-on-task-complete.md`).

## Known plan deviations (already decided)

Implementation-level choices live in `decisions.md`; read it before "fixing" anything that looks arbitrary. The deviations from the written plan are:

- Game cron (20.1) is plpgsql + pg_cron with `p_now`, not cron-invoked Edge Functions. Keep new scheduled “compare timestamp, transition row, insert notifications” jobs in that shape; pin SQL windows against TS constants in tests.
- `service_role` needs explicit DML grants; Realtime publication and `REPLICA IDENTITY FULL` matter for calendar/deletes.
- Unlink (13.2) is `[-]`; do not silently implement it mid-MVP unless the user asks.
- Drawing Storage/API exists; drawing **UI** is deferred. MVP async game is battleship only.

## When blocked

Stop and ask: hosted-project confirmation (`21B.1`), App Store submission vs “usable on our phones,” picking up a deferred section, or any change that would claim Req 5.1 while desktop is still deferred.
