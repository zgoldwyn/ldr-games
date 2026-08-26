// Feature: ldr-companion-app, Property 19: Starting a session requires a pairing
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { pairingId, type PairingId } from './common.js';
import { requirePairing } from './pairing-logic.js';

/**
 * Property 19 (task 10.9) — Starting a session requires a pairing.
 *
 * Real-time, asynchronous, and quiz session starts all route through the shared
 * {@link requirePairing} guard. This exercises that guard directly: for *any*
 * account not in a pairing (`pairingId === null`) the start is rejected with
 * `PAIRING_REQUIRED`, while *any* paired account passes and the guard returns
 * that account's pairing id unchanged.
 *
 * Because every session kind (real-time 6.5, asynchronous 7.9, quiz 8.10) uses
 * the same guard, verifying the guard across arbitrary pairing ids covers the
 * partner-required rule for all three start paths.
 */
describe('require-pairing on session start (property)', () => {
  // Arbitrary non-empty pairing id — a paired account references one of these.
  const pairingIdArb: fc.Arbitrary<PairingId> = fc
    .string({ minLength: 1, maxLength: 40 })
    .map((raw) => pairingId(raw));

  // Feature: ldr-companion-app, Property 19: Starting a session requires a pairing
  // Validates: Requirements 6.5, 7.9, 8.10
  it('rejects an unpaired account with PAIRING_REQUIRED and passes a paired one', () => {
    fc.assert(
      fc.property(fc.option(pairingIdArb, { nil: null }), (accountPairingId) => {
        const result = requirePairing({ pairingId: accountPairingId });

        if (accountPairingId === null) {
          // Unpaired account: the session start is rejected (Req 6.5, 7.9, 8.10).
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
          }
        } else {
          // Paired account: the start is allowed and the pairing id is returned
          // unchanged so the caller can attribute the session to the pairing.
          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            expect(result.value).toBe(accountPairingId);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
