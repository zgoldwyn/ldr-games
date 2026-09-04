import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { accountId, invitationCode, pairingId, sessionId, type AccountId, type Timestamp } from './common.js';
import type { Account } from './account.js';
import type { Pairing } from './pairing.js';
import { deleteAccount } from './account-deletion.js';
import {
  createInvitation,
  dissolvePairing,
  requirePairing,
  type ActiveSessionRef,
  type SessionKind,
} from './pairing-logic.js';

/**
 * Property 43 (task 21A.2) — Account deletion leaves the remaining partner
 * consistent.
 *
 * For any active pairing, deleting either member first derives the exact same
 * remaining-partner state and notifications as an ordinary unlink. The pure
 * decision also fixes the irreversible order for the Edge Function: dissolve
 * the pairing before deleting pairing-owned data, account rows, or credentials.
 */

const accountIdArb = fc.string({ minLength: 1, maxLength: 12 }).map(accountId);
const sessionKindArb: fc.Arbitrary<SessionKind> = fc.constantFrom('realtime', 'async', 'quiz');

const activeSessionsArb: fc.Arbitrary<readonly ActiveSessionRef[]> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 5 })
  .chain((ids) =>
    fc.tuple(...ids.map(() => sessionKindArb)).map((kinds) =>
      ids.map((id, i): ActiveSessionRef => ({ sessionId: sessionId(id), kind: kinds[i] })),
    ),
  );

interface PairedDeletionScenario {
  readonly pairing: Pairing;
  readonly memberA: Account;
  readonly memberB: Account;
  readonly deleteMemberA: boolean;
  readonly activeSessions: readonly ActiveSessionRef[];
  readonly now: Timestamp;
}

const pairedDeletionScenarioArb: fc.Arbitrary<PairedDeletionScenario> = fc
  .record({
    pairingRaw: fc.string({ minLength: 1, maxLength: 12 }),
    idA: accountIdArb,
    idB: accountIdArb,
    emailA: fc.emailAddress(),
    emailB: fc.emailAddress(),
    accountCreatedA: fc.integer({ min: 0, max: 1_000_000_000 }),
    accountCreatedB: fc.integer({ min: 0, max: 1_000_000_000 }),
    pairingCreatedAt: fc.integer({ min: 0, max: 1_000_000_000 }),
    activeSessions: activeSessionsArb,
    deleteMemberA: fc.boolean(),
    now: fc.integer({ min: 0, max: 2_000_000_000 }),
  })
  .filter(({ idA, idB }) => idA !== idB)
  .map((r) => {
    const pid = pairingId(r.pairingRaw);
    const memberA: Account = {
      id: r.idA,
      email: r.emailA,
      pairingId: pid,
      createdAt: r.accountCreatedA,
    };
    const memberB: Account = {
      id: r.idB,
      email: r.emailB,
      pairingId: pid,
      createdAt: r.accountCreatedB,
    };
    return {
      pairing: {
        id: pid,
        memberA: memberA.id,
        memberB: memberB.id,
        createdAt: r.pairingCreatedAt,
        status: 'active',
      },
      memberA,
      memberB,
      activeSessions: r.activeSessions,
      deleteMemberA: r.deleteMemberA,
      now: r.now,
    };
  });

interface UnconfirmedDeletionScenario {
  readonly account: Account;
  readonly pairingContext:
    | {
        readonly pairing: Pairing;
        readonly partner: Account;
        readonly activeSessions: readonly ActiveSessionRef[];
      }
    | null;
  readonly now: Timestamp;
}

const unpairedUnconfirmedArb: fc.Arbitrary<UnconfirmedDeletionScenario> = fc
  .record({
    id: accountIdArb,
    email: fc.emailAddress(),
    createdAt: fc.integer({ min: 0, max: 1_000_000_000 }),
    now: fc.integer({ min: 0, max: 2_000_000_000 }),
  })
  .map((r) => ({
    account: {
      id: r.id,
      email: r.email,
      pairingId: null,
      createdAt: r.createdAt,
    },
    pairingContext: null,
    now: r.now,
  }));

const pairedUnconfirmedArb: fc.Arbitrary<UnconfirmedDeletionScenario> =
  pairedDeletionScenarioArb.map((s) => {
    const account = s.deleteMemberA ? s.memberA : s.memberB;
    const partner = s.deleteMemberA ? s.memberB : s.memberA;
    return {
      account,
      pairingContext: {
        pairing: s.pairing,
        partner,
        activeSessions: s.activeSessions,
      },
      now: s.now,
    };
  });

const unconfirmedDeletionScenarioArb = fc.oneof(unpairedUnconfirmedArb, pairedUnconfirmedArb);

function memberIds(accounts: readonly Account[]): ReadonlySet<AccountId> {
  return new Set(accounts.map((account) => account.id));
}

describe('account deletion remaining-partner consistency (property)', () => {
  // Feature: ldr-companion-app, Property 43: Account deletion leaves the remaining partner consistent
  // Validates: Requirement 12.3
  it('matches ordinary unlink effects for the partner left behind', () => {
    fc.assert(
      fc.property(pairedDeletionScenarioArb, (s) => {
        const account = s.deleteMemberA ? s.memberA : s.memberB;
        const partner = s.deleteMemberA ? s.memberB : s.memberA;

        const deletion = deleteAccount({
          account,
          confirmed: true,
          pairingContext: {
            pairing: s.pairing,
            partner,
            activeSessions: s.activeSessions,
          },
          now: s.now,
        });
        const unlink = dissolvePairing({
          pairing: s.pairing,
          memberA: s.memberA,
          memberB: s.memberB,
          activeSessions: s.activeSessions,
          now: s.now,
        });

        expect(isOk(deletion)).toBe(true);
        expect(isOk(unlink)).toBe(true);
        if (!isOk(deletion) || !isOk(unlink)) return;

        const expectedRemaining = s.deleteMemberA ? unlink.value.memberB : unlink.value.memberA;
        const out = deletion.value;

        expect(out.confirmed).toBe(true);
        expect(out.pairingDissolution).toStrictEqual(unlink.value);
        expect(out.remainingPartner).toStrictEqual(expectedRemaining);
        expect(out.remainingPartner?.pairingId).toBeNull();
        expect(out.remainingPartner?.id).toBe(partner.id);
        expect(out.remainingPartner?.email).toBe(partner.email);
        expect(out.remainingPartner?.createdAt).toBe(partner.createdAt);

        const guard = requirePairing(expectedRemaining);
        expect(isErr(guard)).toBe(true);
        if (isErr(guard)) {
          expect(guard.error.code).toBe(ERROR_CODES.PAIRING_REQUIRED);
        }

        const reinvite = createInvitation({
          code: invitationCode(`after-delete-${partner.id}`),
          inviter: expectedRemaining,
          now: s.now,
        });
        expect(isOk(reinvite)).toBe(true);

        expect(out.pairingOwnedDataToDelete).toEqual([s.pairing.id]);
        expect(out.terminatedSessions).toStrictEqual(s.activeSessions);
        expect(out.notifications).toStrictEqual(unlink.value.notifications);
        expect(memberIds([account, partner]).has(out.accountId)).toBe(true);
        expect(out.email).toBe(account.email);

        expect(out.steps.map((step) => step.kind)).toEqual([
          'dissolve_pairing',
          'delete_pairing_owned_data',
          'terminate_authenticated_sessions',
          'delete_account_row',
          'delete_auth_user',
        ]);
        expect(out.steps[0]).toEqual({ kind: 'dissolve_pairing', pairingId: s.pairing.id });
      }),
      { numRuns: 100 },
    );
  });
});

describe('unconfirmed account deletion no-op (property)', () => {
  // Feature: ldr-companion-app, Property 44: An unconfirmed deletion changes nothing
  // Validates: Requirement 12.8
  it('leaves unpaired and paired account state byte-identical', () => {
    fc.assert(
      fc.property(unconfirmedDeletionScenarioArb, (s) => {
        const before = JSON.stringify(s);

        const result = deleteAccount({
          account: s.account,
          confirmed: false,
          pairingContext: s.pairingContext,
          now: s.now,
        });

        expect(JSON.stringify(s)).toBe(before);
        expect(isOk(result)).toBe(true);
        if (!isOk(result)) return;

        expect(result.value.confirmed).toBe(false);
        expect(result.value.account).toStrictEqual(s.account);
        expect(result.value.pairing).toStrictEqual(s.pairingContext?.pairing ?? null);
        expect(result.value.partner).toStrictEqual(s.pairingContext?.partner ?? null);
        expect(result.value.steps).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
