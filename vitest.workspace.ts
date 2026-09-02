import { defineWorkspace } from 'vitest/config';

// The test harness is split into three suites by filename convention so each can
// be run independently (`npm run test:unit`, `test:property`, `test:integration`)
// or all together (`npm test`):
//
//   *.test.ts              → unit tests (specific examples and edge cases)
//   *.property.test.ts     → fast-check property-based tests (universal properties)
//   *.integration.test.ts  → integration tests (exercise the running Supabase stack)
//
// Property tests for this feature are tagged in-source with the convention
//   // Feature: ldr-companion-app, Property {n}: {text}
// and run a minimum of 100 iterations (configured in vitest.setup.property.ts).
const commonExclude = ['**/node_modules/**', '**/dist/**', '**/build/**'];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
      exclude: [...commonExclude, '**/*.property.test.ts', '**/*.integration.test.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'property',
      include: ['packages/**/*.property.test.ts', 'apps/**/*.property.test.ts'],
      exclude: commonExclude,
      setupFiles: ['./vitest.setup.property.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
      exclude: commonExclude,
      // Integration tests talk to a live stack: a Realtime channel handshake plus
      // a latency budget (5s for Req 5.3, 10s for the Req 5.5 queue drain) does
      // not fit vitest's 5s default, and a test that asserts a 5s budget must not
      // be killed by the runner at exactly 5s. The per-requirement budgets are
      // asserted inside the tests; this is only the outer safety net.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // NOTE: these suites must run SERIALLY — they share one local Supabase
      // stack, and in parallel they contend for the same Postgres, Realtime and
      // edge runtime, which turns a latency assertion into a measure of
      // contention (the Req 5.3 propagation test measures ~0.9s alone but blew
      // its 5s budget at ~6.2s alongside seven other suites).
      //
      // `fileParallelism` CANNOT be set per-project — vitest only honours it at
      // the root or from the CLI — so it is passed as `--no-file-parallelism` by
      // the `test:integration` / `test:integration:local` scripts instead.
      // Setting it here silently does nothing.
    },
  },
]);
