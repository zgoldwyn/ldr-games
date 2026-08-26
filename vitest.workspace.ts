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
    },
  },
]);
