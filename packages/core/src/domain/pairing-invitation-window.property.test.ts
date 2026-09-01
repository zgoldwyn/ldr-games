/**
 * Property-based coverage for the invitation validity window and expiry
 * (Requirements 3.1 and 3.5).
 *
 * These properties exercise Property 12: for any invitation, its expiry equals
 * its creation time plus exactly 72 hours (Req 3.1), and accepting it at any
 * time strictly after that expiry is rejected with an expiration error while
 * both accounts' pairing state is left unchanged (Req 3.5). The exact 72h
 * boundary is exercised deliberately: acceptance at the boundary succeeds,
 * while acceptance one millisecond past it fails.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId } from './common.js';
import type { Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Invitation } from './pairing.js';
import {
  INVITATION_VALIDITY_MS,
  acceptInvitation,
  computeInvitationExpiry,
  createInvitation,
} from './pairing-logic.js';

// A fixed, positive epoch base keeps generated timestamps comfortably away from
// zero so offsets never produce negative instants.
const BASE: Timestamp = 1_700_000_000_000;

const INVITER = accountId('inviter');
const PAIRING = pairingId('pair-1');
const CODE = invitationCode('ABC123');

function makeAccount(id: string): Account {
  return { id: accountId(id), email: `${id}@example.com`, pairingId: null, createdAt: BASE - 1 };
}

/** Arbitrary creation instant across a wide, always-positive range. */
const createdAtArb = fc.integer({ min: BASE, max: BASE + 10 * INVITATION_VALIDITY_MS });

describe('invitation validity window (Requirements 3.1, 3.5)', () => {
  // Feature: ldr-companion-app, Property 12: Invitation validity window and expiry
  it('expiry always equals creation time plus exactly 72 hours (Req 3.1)', () => {
    fc.assert(
      fc.property(createdAtArb, (createdAt) => {
        const result = createInvitation({ code: CODE, inviter: makeAccount('inviter'), now: createdAt });
        expect(isOk(result)).toBe(true);
        if (isOk(result)) {
          expect(result.value.createdAt).toBe(createdAt);
          expect(result.value.expiresAt).toBe(createdAt + 72 * 60 * 60 * 1000);
          expect(result.value.expiresAt).toBe(computeInvitationExpiry(createdAt));
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 12: Invitation validity window and expiry
  it('accepting at or before the 72h boundary succeeds and creates a pairing (Req 3.1)', () => {
    fc.assert(
      fc.property(
        createdAtArb,
        // Offset from creation within the closed window [0, 72h].
        fc.integer({ min: 0, max: INVITATION_VALIDITY_MS }),
        (createdAt, withinOffset) => {
          const invitation: Invitation = {
            code: CODE,
            inviterAccountId: INVITER,
            createdAt,
            expiresAt: computeInvitationExpiry(createdAt),
            status: 'pending',
          };
          const now = createdAt + withinOffset; // at most exactly the boundary

          const result = acceptInvitation({
            invitation,
            inviter: makeAccount('inviter'),
            invitee: makeAccount('invitee'),
            pairingId: PAIRING,
            now,
          });

          expect(isOk(result)).toBe(true);
          if (isOk(result)) {
            expect(result.value.pairing.status).toBe('active');
            expect(result.value.invitation.status).toBe('consumed');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: ldr-companion-app, Property 12: Invitation validity window and expiry
  it('accepting strictly after the 72h boundary is rejected as expired with no state change (Req 3.5)', () => {
    fc.assert(
      fc.property(
        createdAtArb,
        // Any strictly positive offset past the expiry boundary.
        fc.integer({ min: 1, max: 10 * INVITATION_VALIDITY_MS }),
        (createdAt, pastOffset) => {
          const invitation: Invitation = {
            code: CODE,
            inviterAccountId: INVITER,
            createdAt,
            expiresAt: computeInvitationExpiry(createdAt),
            status: 'pending',
          };
          const inviter = makeAccount('inviter');
          const invitee = makeAccount('invitee');
          const now = invitation.expiresAt + pastOffset; // strictly after expiry

          const result = acceptInvitation({ invitation, inviter, invitee, pairingId: PAIRING, now });

          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe(ERROR_CODES.INVITATION_EXPIRED);
          }
          // No pairing state change: the caller's account state is untouched
          // because acceptInvitation never mutates its inputs on any branch.
          expect(inviter.pairingId).toBeNull();
          expect(invitee.pairingId).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});
