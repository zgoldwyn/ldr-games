import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import {
  INACTIVITY_LIMIT_MS,
  evaluateSession,
  type SessionValidityInput,
} from './session-epoch.js';

/**
 * Property 8 (task 3.7) — Single active session invariant.
 *
 * The single-session registry advances a monotonically increasing `epoch` on
 * every new login; a token carries the epoch it was issued with and is valid
 * only while it still equals the registry's current epoch. This exercises the
 * pure epoch side of {@link evaluateSession}: across a sequence of logins (and
 * a possible sign-out that advances the registry past every issued token), at
 * most one token is valid, that token is the one from the most recent login,
 * and every superseded token is denied with `SESSION_SUPERSEDED`.
 *
 * Activity times are pinned well inside the 30-day inactivity window so the
 * inactivity guard never fires and the epoch check is what decides validity.
 */
describe('session-epoch: single active session invariant (property)', () => {
  // A model of the issued tokens for one account plus the registry's current
  // epoch. `tokenEpochs` are strictly increasing (one per successive login);
  // `currentEpoch` is either the latest issued epoch (a login is active) or a
  // strictly greater value (the active session was signed out / displaced, so
  // no issued token is valid).
  interface RegistryModel {
    readonly tokenEpochs: number[];
    readonly currentEpoch: number;
    readonly signedOut: boolean;
  }

  const registryArb: fc.Arbitrary<RegistryModel> = fc
    .record({
      // Epoch the very first login was issued at.
      base: fc.integer({ min: 0, max: 1_000 }),
      // Strictly-positive gaps between successive logins keep epochs increasing.
      gaps: fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 25 }),
      // When true, the registry has advanced past every issued token (sign-out).
      signedOut: fc.boolean(),
      signOutBump: fc.integer({ min: 1, max: 100 }),
    })
    .map(({ base, gaps, signedOut, signOutBump }) => {
      const tokenEpochs: number[] = [];
      let epoch = base;
      for (const gap of gaps) {
        tokenEpochs.push(epoch);
        epoch += gap;
      }
      const latest = tokenEpochs[tokenEpochs.length - 1];
      const currentEpoch = signedOut ? latest + signOutBump : latest;
      return { tokenEpochs, currentEpoch, signedOut };
    });

  // Feature: ldr-companion-app, Property 8: Single active session invariant
  // Validates: Requirements 2.5, 2.7, 2.8, 2.9
  it('keeps at most one token valid — the most recent login — and denies all superseded tokens', () => {
    fc.assert(
      fc.property(
        registryArb,
        // last activity is recent relative to `now`, strictly inside the window.
        fc.integer({ min: 0, max: INACTIVITY_LIMIT_MS - 1 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (model, activityDelta, nowBase) => {
          const now = nowBase + INACTIVITY_LIMIT_MS;
          const lastActivityAt = now - activityDelta;

          const results = model.tokenEpochs.map((tokenEpoch) => {
            const input: SessionValidityInput = {
              tokenEpoch,
              currentEpoch: model.currentEpoch,
              lastActivityAt,
              now,
            };
            return { tokenEpoch, result: evaluateSession(input) };
          });

          const valid = results.filter((r) => isOk(r.result));
          const invalid = results.filter((r) => isErr(r.result));

          // At most one session token is valid at any time (Req 2.5, 2.7).
          expect(valid.length).toBeLessThanOrEqual(1);

          if (model.signedOut) {
            // The registry advanced past every issued token: none are valid, and
            // each is denied because a newer registry epoch superseded it (2.9).
            expect(valid.length).toBe(0);
          } else {
            // A login is active: exactly one token is valid and it is the one
            // issued by the most recent login (the highest issued epoch) (2.8).
            expect(valid.length).toBe(1);
            const mostRecent = Math.max(...model.tokenEpochs);
            expect(valid[0].tokenEpoch).toBe(mostRecent);
          }

          // Every token that is not the registry's current epoch is denied, and
          // the denial reason is that it was superseded by a newer login (2.9).
          for (const { tokenEpoch, result } of invalid) {
            expect(tokenEpoch).not.toBe(model.currentEpoch);
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.error.code).toBe(ERROR_CODES.SESSION_SUPERSEDED);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
