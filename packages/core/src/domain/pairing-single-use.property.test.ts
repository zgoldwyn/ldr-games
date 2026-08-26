import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId } from './common.js';
import type { Account } from './account.js';
import type { Invitation } from './pairing.js';
import { acceptInvitation, computeInvitationExpiry } from './pairing-logic.js';

/**
 * Property 13 (task 10.5) — Invitation is single-use.
 *
 * For any invitation that has already been consumed to create a pairing, every
 * subsequent attempt to accept it must fail with `INVITATION_ALREADY_CONSUMED`
 * and create no additional pairing (Requirement 3.8). We first drive a valid
 * acceptance to consume a fresh pending invitation, then replay acceptance any
 * number of times against the consumed invitation and assert each replay is
 * rejected and yields no new state.
 *
 * The consumed check takes precedence over expiry and exclusivity, so we vary
 * `now` (before and after the 72h window) and the paired-state of the replay
 * accounts to confirm reuse is always denied for the single-use reason.
 */
describe('pairing single-use invitation (property)', () => {
  function makeAccount(id: string, pairing: string | null = null): Account {
    return {
      id: accountId(id),
      email: `${id}@example.com`,
      pairingId: pairing === null ? null : pairingId(pairing),
      createdAt: 0,
    };
  }

  // A fresh, pending invitation together with the accounts and timing needed to
  // consume it exactly once within its validity window.
  const scenarioArb = fc
    .record({
      code: fc.string({ minLength: 1, maxLength: 12 }),
      inviterId: fc.string({ minLength: 1, maxLength: 10 }),
      inviteeId: fc.string({ minLength: 1, maxLength: 10 }),
      firstPairingId: fc.string({ minLength: 1, maxLength: 10 }),
      createdAt: fc.integer({ min: 0, max: 10_000_000 }),
      // How far into the 72h window the first (valid) acceptance happens.
      acceptDelta: fc.integer({ min: 0, max: computeInvitationExpiry(0) }),
      // Number of reuse attempts to replay after consumption.
      reuseCount: fc.integer({ min: 1, max: 5 }),
      // Whether each reuse happens after the original expiry window.
      reuseAfterExpiry: fc.boolean(),
      // Whether the replay accounts are already paired (exclusivity would also
      // reject, but the consumed check must win).
      replayInviterPaired: fc.boolean(),
      replayInviteePaired: fc.boolean(),
    })
    // Distinct account ids so the pairing links two different accounts.
    .filter(({ inviterId, inviteeId }) => inviterId !== inviteeId);

  // Feature: ldr-companion-app, Property 13: Invitation is single-use
  // Validates: Requirements 3.8
  it('rejects every reuse of a consumed invitation and creates no additional pairing', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const inviter = makeAccount(s.inviterId);
        const invitee = makeAccount(s.inviteeId);
        const invitation: Invitation = {
          code: invitationCode(s.code),
          inviterAccountId: inviter.id,
          createdAt: s.createdAt,
          expiresAt: computeInvitationExpiry(s.createdAt),
          status: 'pending',
        };

        // First acceptance within the window consumes the invitation exactly once.
        const first = acceptInvitation({
          invitation,
          inviter,
          invitee,
          pairingId: pairingId(s.firstPairingId),
          now: s.createdAt + s.acceptDelta,
        });

        expect(isOk(first)).toBe(true);
        if (!isOk(first)) return;
        const consumed = first.value.invitation;
        expect(consumed.status).toBe('consumed');

        // Every subsequent attempt to accept the consumed invitation must fail
        // and produce no new pairing, regardless of timing or account state.
        for (let attempt = 0; attempt < s.reuseCount; attempt += 1) {
          const now = s.reuseAfterExpiry
            ? invitation.expiresAt + 1 + attempt
            : s.createdAt + s.acceptDelta;

          const replay = acceptInvitation({
            invitation: consumed,
            inviter: makeAccount(s.inviterId, s.replayInviterPaired ? 'other-a' : null),
            invitee: makeAccount(s.inviteeId, s.replayInviteePaired ? 'other-b' : null),
            pairingId: pairingId(`reuse-${attempt}`),
            now,
          });

          expect(isErr(replay)).toBe(true);
          if (isErr(replay)) {
            expect(replay.error.code).toBe(ERROR_CODES.INVITATION_ALREADY_CONSUMED);
          }
          // No new pairing state is ever produced on the error branch.
          expect(isOk(replay)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
