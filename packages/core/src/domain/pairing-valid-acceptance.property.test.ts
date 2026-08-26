/**
 * Property-based coverage for valid invitation acceptance (Requirement 3.2).
 *
 * Property 11 states: for any pending invitation accepted at a time within 72
 * hours of its creation while both accounts are unpaired, a pairing linking
 * exactly those two accounts is created. The generators below build a pending
 * invitation, two distinct unpaired accounts, and an acceptance instant chosen
 * anywhere inside the [createdAt, createdAt + 72h] window (including both
 * boundaries), then assert `acceptInvitation` succeeds and produces the
 * consistent linked-pairing state.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { accountId, invitationCode, pairingId } from './common.js';
import type { Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Invitation } from './pairing.js';
import {
  INVITATION_VALIDITY_MS,
  acceptInvitation,
  computeInvitationExpiry,
} from './pairing-logic.js';

// A fixed, positive epoch base keeps all generated timestamps comfortably away
// from zero so offsets never produce negative instants.
const BASE: Timestamp = 1_700_000_000_000;

/** An unpaired account with the given id suffix. */
const unpairedAccount = (id: string): Account => ({
  id: accountId(id),
  email: `${id}@example.com`,
  pairingId: null,
  createdAt: BASE - 1000,
});

describe('acceptInvitation valid acceptance (Requirement 3.2)', () => {
  // Feature: ldr-companion-app, Property 11: Valid acceptance within window creates the pairing
  it('creates a pairing linking exactly the two accounts when accepted within the 72h window', () => {
    fc.assert(
      fc.property(
        // createdAt anywhere in a wide positive range.
        fc.integer({ min: 0, max: 10 * INVITATION_VALIDITY_MS }),
        // Acceptance offset within the window, including the exact boundaries.
        fc.integer({ min: 0, max: INVITATION_VALIDITY_MS }),
        // Distinct account and pairing identifiers.
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        (createdOffset, acceptOffset, inviterRaw, inviteeRaw, pairRaw, codeRaw) => {
          const createdAt = (BASE + createdOffset) as Timestamp;
          const now = (createdAt + acceptOffset) as Timestamp;

          // Guarantee the two accounts are distinct.
          const inviter = unpairedAccount(`inviter-${inviterRaw}`);
          const invitee = unpairedAccount(`invitee-${inviteeRaw}`);
          const pairId = pairingId(`pair-${pairRaw}`);

          const invitation: Invitation = {
            code: invitationCode(`code-${codeRaw}`),
            inviterAccountId: inviter.id,
            createdAt,
            expiresAt: computeInvitationExpiry(createdAt),
            status: 'pending',
          };

          const result = acceptInvitation({
            invitation,
            inviter,
            invitee,
            pairingId: pairId,
            now,
          });

          // Acceptance within the window always succeeds.
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;

          const { pairing, invitation: consumed, inviter: newInviter, invitee: newInvitee } =
            result.value;

          // The pairing links exactly the inviter and invitee accounts.
          expect(pairing.memberA).toBe(inviter.id);
          expect(pairing.memberB).toBe(invitee.id);
          expect(pairing.id).toBe(pairId);
          expect(pairing.status).toBe('active');
          expect(pairing.createdAt).toBe(now);

          // The invitation is consumed and both accounts now reference the pairing.
          expect(consumed.status).toBe('consumed');
          expect(newInviter.pairingId).toBe(pairId);
          expect(newInvitee.pairingId).toBe(pairId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
