import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

// Property-suite smoke test (`*.property.test.ts`). Confirms fast-check is
// importable and the property project applies the global 100-iteration floor.
// Real, numbered properties (tagged per the feature convention) are added in
// later tasks alongside the pure domain helpers they validate.
describe('test harness (property suite)', () => {
  // Feature: ldr-companion-app, Property 0: harness sanity — reversing a string twice is the identity
  it('exercises fast-check with the configured iteration floor', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const reversed = [...s].reverse().reverse().join('');
        expect(reversed).toBe(s);
      }),
    );
  });
});
