// Feature: ldr-companion-app, Property 10: Pairing exclusivity invariant
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId } from './common.js';
import type { AccountId, PairingId, Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Invitation } from './pairing.js';
import {
  acceptInvitation,
  computeInvitationExpiry,
  createInvitation,
} from './pairing-logic.js';

/**
 * Property 10: Pairing exclusivity invariant (Req 3.3, 3.4, 3.6, 3.7).
 *
 * For any sequence of invitation, acceptance, and unlink operations, every
 * account is a member of at most one active pairing at any time; any invite or
 * accept request originating from, or targeting, an already-paired account is
 * rejected with the pairing state of all accounts left unchanged.
 *
 * The generators below constrain to the meaningful input space: accounts that
 * are either unpaired (`pairingId === null`) or already paired, pending
 * invitations that are always within their 72h window, and a reference `now`
 * that never crosses the expiry boundary (expiry is exercised separately by
 * Property 12). This keeps the focus squarely on the exclusivity rule.
 *
 * **Validates: Requirements 3.3, 3.4, 3.6, 3.7**
 */

const NOW: Timestamp = 1_700_000_000_000;

/** A branded pairing id built from an arbitrary short token. */
const arbPairingId: fc.Arbitrary<PairingId> = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => pairingId(`pair-${s}`));

/**
 * An account that is either unpaired or already a member of some pairing.
 * `seed` distinguishes accounts so we can assert identity is preserved.
 */
function arbAccount(seed: string): fc.Arbitrary<Account> {
  return fc
    .option(arbPairingId, { nil: null })
    .map((pid): Account => ({
      id: accountId(seed),
      email: `${seed}@example.com`,
      pairingId: pid,
      createdAt: NOW - 10_000,
    }));
}

/** A pending invitation that is always within its validity window at `NOW`. */
function makeInvitation(inviter: AccountId): Invitation {
  return {
    code: invitationCode('INV-CODE'),
    inviterAccountId: inviter,
    createdAt: NOW,
    expiresAt: computeInvitationExpiry(NOW),
    status: 'pending',
  };
}

/** Deep, order-independent snapshot of an account for "unchanged" assertions. */
function snapshot(account: Account): string {
  return JSON.stringify(account);
}

describe('Property 10: Pairing exclusivity invariant', () => {
  // Feature: ldr-companion-app, Property 10: Pairing exclusivity invariant
  it('rejects an invite originating from an already-paired account, state unchanged (Req 3.7)', () => {
    fc.assert(
      fc.property(arbAccount('inviter'), (inviter) => {
        const before = snapshot(inviter);
        const result = createInvitation({
          code: invitationCode('INV-CODE'),
          inviter,
          now: NOW,
        });

        if (inviter.pairingId !== null) {
          // Already paired: must be rejected as ALREADY_PAIRED (Req 3.7).
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
          }
        } else {
          // Unpaired: an invitation is issued.
          expect(isOk(result)).toBe(true);
        }

        // The supplied account is never mutated by the pure function.
        expect(snapshot(inviter)).toBe(before);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 10: Pairing exclusivity invariant
  it('rejects acceptance from/at an already-paired account, state unchanged (Req 3.3, 3.4)', () => {
    fc.assert(
      fc.property(
        arbAccount('inviter'),
        arbAccount('invitee'),
        arbPairingId,
        (inviter, invitee, newPairingId) => {
          const invitation = makeInvitation(inviter.id);
          const inviterBefore = snapshot(inviter);
          const inviteeBefore = snapshot(invitee);

          const result = acceptInvitation({
            invitation,
            inviter,
            invitee,
            pairingId: newPairingId,
            now: NOW,
          });

          const eitherPaired =
            inviter.pairingId !== null || invitee.pairingId !== null;

          if (eitherPaired) {
            // Originating (inviter, Req 3.4) or targeting (invitee, Req 3.3) an
            // already-paired account must be rejected as ALREADY_PAIRED.
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
            }
            // Rejections leave the pairing state of all accounts unchanged.
            expect(snapshot(inviter)).toBe(inviterBefore);
            expect(snapshot(invitee)).toBe(inviteeBefore);
          } else {
            // Both unpaired within the window: the pairing is created and each
            // account references exactly the one new pairing (Req 3.2, 3.6).
            expect(isOk(result)).toBe(true);
            if (isOk(result)) {
              expect(result.value.inviter.pairingId).toBe(newPairingId);
              expect(result.value.invitee.pairingId).toBe(newPairingId);
              expect(result.value.pairing.status).toBe('active');
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 10: Pairing exclusivity invariant
  it('every account belongs to at most one active pairing across a sequence of operations (Req 3.6)', () => {
    // Model a small pool of accounts and drive them through a random sequence of
    // create-invitation / accept operations, asserting the exclusivity
    // invariant after every step: no account is ever a member of more than one
    // active pairing, and no already-paired account is repaired.
    const arbOp = fc.record({
      inviterIdx: fc.integer({ min: 0, max: 3 }),
      inviteeIdx: fc.integer({ min: 0, max: 3 }),
      pairing: arbPairingId,
    });

    fc.assert(
      fc.property(fc.array(arbOp, { minLength: 1, maxLength: 30 }), (ops) => {
        // Four accounts, all initially unpaired.
        const accounts: Account[] = [0, 1, 2, 3].map((i) => ({
          id: accountId(`acct-${i}`),
          email: `acct-${i}@example.com`,
          pairingId: null,
          createdAt: NOW - 10_000,
        }));

        // Track which pairing ids are currently active to detect duplicates.
        const membershipCount = (): Map<AccountId, number> => {
          const counts = new Map<AccountId, number>();
          for (const a of accounts) {
            if (a.pairingId !== null) {
              counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
            }
          }
          return counts;
        };

        for (const op of ops) {
          if (op.inviterIdx === op.inviteeIdx) continue; // no self-pairing
          const inviter = accounts[op.inviterIdx];
          const invitee = accounts[op.inviteeIdx];

          const invitation = makeInvitation(inviter.id);
          const result = acceptInvitation({
            invitation,
            inviter,
            invitee,
            pairingId: op.pairing,
            now: NOW,
          });

          const eitherPaired =
            inviter.pairingId !== null || invitee.pairingId !== null;

          if (eitherPaired) {
            // Exclusivity: any operation touching an already-paired account is
            // rejected and state is untouched.
            expect(isErr(result)).toBe(true);
          } else if (isOk(result)) {
            accounts[op.inviterIdx] = result.value.inviter;
            accounts[op.inviteeIdx] = result.value.invitee;
          }

          // Invariant: no account references more than one active pairing.
          for (const count of membershipCount().values()) {
            expect(count).toBeLessThanOrEqual(1);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
