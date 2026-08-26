# LDR Companion App

Cross-platform (mobile + desktop) companion app for people in long-distance
relationships. Two people link their accounts into an exclusive one-to-one
pairing and share real-time and turn-based games, themed quizzes, and a calendar
of important dates with reminders.

## Monorepo layout

This is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
monorepo. Shared domain logic lives in a single TypeScript core consumed
identically by both platform shells so the experience matches across devices
(Requirement 5.1).

```
.
├── packages/
│   └── core/        # @ldr/core — shared domain logic, service modules, theme tokens
├── apps/
│   ├── mobile/      # @ldr/mobile — React Native / Expo shell
│   └── desktop/     # @ldr/desktop — Electron / web shell
├── tsconfig.base.json   # shared compiler options
├── tsconfig.json        # solution file (project references)
├── eslint.config.js     # shared flat ESLint config
├── .prettierrc.json     # shared Prettier config
└── vitest.config.ts     # shared test runner config
```

TypeScript [project references](https://www.typescriptlang.org/docs/handbook/project-references.html)
wire the packages together: `apps/mobile` and `apps/desktop` reference
`packages/core`, so `tsc --build` compiles them in dependency order.

## Common commands

Run from the repo root:

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `npm install`       | Install all workspace dependencies                 |
| `npm run build`     | Type-check and build every package (`tsc --build`) |
| `npm run typecheck` | Force a full type-check across the workspace       |
| `npm run lint`      | Lint all packages with ESLint                      |
| `npm run format`    | Format the repo with Prettier                      |
| `npm test`          | Run the test suite with Vitest                     |

## Status

This is the foundational scaffolding (task 1.1). The shared core currently
exposes the swappable theme token system (default color option: `pink`).
Supabase local dev tooling, `fast-check` property testing, the domain modules,
and the platform UIs are added in subsequent tasks.
