import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId, type Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Pairing } from './pairing.js';
import { createInvitation, dissolvePairing, isPaired, requirePairing } from './pairing-logic.js';

/**
 * Property 14 (task 10.6) — Dissolution unpairs, retains individual data,
 * revokes pairing data.
 *
 * For any active pairing that is dissolved, both former partners are set to an
 * unpaired state and become eligible to create or accept a new invitation, each
 * partner's individual data is retained, and all pairing-owned data becomes
 * inaccessible to both. In the pure domain layer, access to pairing-owned data
 * is mediated entirely by `Account.pairingId` (the RLS predicate); clearing it
 * both unpairs the account (Req 4.3) and revokes access to the former pairing's
 * data (Req 4.4). Eligibility to re-pair is exercised concretely by confirming
 * each former partner can once again create an invitation, and revocation of
 * shared-feature access by confirming `requirePairing` now denies them (Req 4.1).
 */
describe('pairing dissolution effects (property)', () => {
  // A model of an active pairing together with its two distinct member accounts.
  interface PairingModel {
    readonly pairing: Pairing;
    readonly memberA: Account;
    readonly memberB: Account;
  }

  const pairingModelArb: fc.Arbitrary<PairingModel> = fc
    .record({
      pairingRaw: fc.string({ minLength: 1, maxLength: 12 }),
      idA: fc.string({ minLength: 1, maxLength: 12 }),
      idB: fc.string({ minLength: 1, maxLength: 12 }),
      emailA: fc.emailAddress(),
      emailB: fc.emailAddress(),
      createdA: fc.integer({ min: 0, max: 1_000_000_000 }),
      createdB: fc.integer({ min: 0, max: 1_000_000_000 }),
      pairingCreatedAt: fc.integer({ min: 0, max: 1_000_000_000 }),
    })
    // Keep the two members distinct so their individual data can be told apart.
    .filter(({ idA, idB }) => idA !== idB)
    .map(({ pairingRaw, idA, idB, emailA, emailB, createdA, createdB, pairingCreatedAt }) => {
      const pid = pairingId(pairingRaw);
      const memberA: Account = {
        id: accountId(idA),
        email: emailA,
        pairingId: pid,
        createdAt: createdA,
      };
      const memberB: Account = {
        id: accountId(idB),
        email: emailB,
        pairingId: pid,
        createdAt: createdB,
      };
      const pairing: Pairing = {
        id: pid,
        memberA: memberA.id,
        memberB: memberB.id,
        createdAt: pairingCreatedAt,
        status: 'active',
      };
      return { pairing, memberA, memberB };
    });

  // Feature: ldr-companion-app, Property 14: Dissolution unpairs, retains individual data, revokes pairing data
  // Validates: Requirements 4.1, 4.3, 4.4
  it('unpairs both partners, retains individual data, and revokes pairing-owned access', () => {
    fc.assert(
      fc.property(
        pairingModelArb,
        fc.integer({ min: 0, max: 2_000_000_000 }),
        ({ pairing, memberA, memberB }, now: Timestamp) => {
          const result = dissolvePairing({ pairing, memberA, memberB, now });

          // Dissolving an active pairing always succeeds.
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;

          const out = result.value;

          // The pairing itself is marked dissolved.
          expect(out.pairing.status).toBe('dissolved');

          // Req 4.3 — both former partners are set to an unpaired state.
          expect(out.memberA.pairingId).toBeNull();
          expect(out.memberB.pairingId).toBeNull();
          expect(isPaired(out.memberA)).toBe(false);
          expect(isPaired(out.memberB)).toBe(false);

          // Req 4.4 — each partner's individual data is retained (only the
          // pairing linkage changes; id, email, and createdAt are untouched).
          for (const [before, after] of [
            [memberA, out.memberA],
            [memberB, out.memberB],
          ] as const) {
            expect(after.id).toBe(before.id);
            expect(after.email).toBe(before.email);
            expect(after.createdAt).toBe(before.createdAt);
          }

          // Req 4.4 — all pairing-owned data becomes inaccessible to both:
          // neither former partner still references the dissolved pairing, which
          // is the sole predicate granting access to that pairing's data.
          expect(out.memberA.pairingId).not.toBe(pairing.id);
          expect(out.memberB.pairingId).not.toBe(pairing.id);

          // Req 4.1 — shared-feature access is revoked for both accounts: the
          // pairing guard now denies starting any session.
          for (const account of [out.memberA, out.memberB]) {
            const guard = requirePairing(account);
            expect(isErr(guard)).toBe(true);
            if (isErr(guard)) {
              expect(guard.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
            }
          }

          // Req 4.3 — each former partner becomes eligible to create (and thus
          // to accept) a new invitation now that they are unpaired.
          for (const account of [out.memberA, out.memberB]) {
            const reinvite = createInvitation({
              code: invitationCode(`reinvite-${account.id}`),
              inviter: account,
              now,
            });
            expect(isOk(reinvite)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
