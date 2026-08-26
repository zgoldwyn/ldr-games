import { describe, expect, it } from 'vitest';

// Unit-suite smoke test (`*.test.ts`). Verifies the unit project is wired up and
// serves as the template for example/edge-case tests added in later tasks.
describe('test harness (unit suite)', () => {
  it('runs unit tests from the core package', () => {
    expect(1 + 1).toBe(2);
  });
});
