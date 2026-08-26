import * as fc from 'fast-check';

// Property-based tests for the LDR Companion App run a minimum of 100 iterations
// each (per the implementation plan). Configuring it globally here means every
// `*.property.test.ts` file inherits the floor without repeating `{ numRuns }`
// on each assertion; individual properties may raise it but should not lower it.
fc.configureGlobal({ numRuns: 100 });
