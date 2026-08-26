import { defineConfig } from 'vitest/config';

// Base test-runner configuration shared by every suite. Suite-specific file
// discovery is defined per project in `vitest.workspace.ts` (unit / property /
// integration); this file holds the settings common to all of them.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
