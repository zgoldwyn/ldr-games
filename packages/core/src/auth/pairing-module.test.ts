import { describe, expect, it } from 'vitest';

import { invitationCode as toInvitationCode } from '../domain/common.js';
import { ERROR_CODES, type PairingError } from '../errors.js';
import { isErr, isOk } from '../result.js';
import {
  createPairingModule,
  invitationFromPayload,
  pairingFromPayload,
  type InvitationPayload,
  type PairingPayload,
  type PairingPorts,
} from './pairing-module.js';

// Unit tests for the client PairingModule (Req 3.1-3.8, 4.1, 4.3).
//
// Stub ports rather than a Supabase client. Exclusivity, single-use consumption
// and the dissolution transaction are DATABASE guarantees, already asserted in
// `__harness__/pairing.integration.test.ts`; re-stubbing them here would test the
// stub. What this module owns is the wire-to-domain conversion (ISO strings to
// epoch milliseconds) and faithfully surfacing each stable error code, which is
// what a shell branches on.

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CODE = toInvitationCode('c0de-c0de-c0de');
const NOW = 1_700_000_000_000;
/** The invitation validity window (Req 3.1). */
const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

function invitationPayload(overrides: Partial<InvitationPayload> = {}): InvitationPayload {
  return {
    code: CODE,
    inviterAccountId: ALICE,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + SEVENTY_TWO_HOURS_MS).toISOString(),
    status: 'pending',
    ...overrides,
  };
}

function pairingPayload(overrides: Partial<PairingPayload> = {}): PairingPayload {
  return {
    id: 'pairing-1',
    memberA: ALICE,
    memberB: BOB,
    createdAt: new Date(NOW).toISOString(),
    status: 'active',
    ...overrides,
  };
}

function harness(
  options: {
    createInvitation?: PairingPorts['createInvitation'];
    acceptInvitation?: PairingPorts['acceptInvitation'];
    unlink?: PairingPorts['unlink'];
    pairing?: PairingPayload | null;
  } = {},
) {
  let unlinkCalls = 0;
  const accepted: string[] = [];

  const ports: PairingPorts = {
    createInvitation:
      options.createInvitation ??
      (async () => ({ ok: true, invitation: invitationPayload() })),
    acceptInvitation:
      options.acceptInvitation ??
      (async (code) => {
        accepted.push(code);
        return { ok: true, pairing: pairingPayload() };
      }),
    unlink:
      options.unlink ??
      (async () => {
        unlinkCalls += 1;
        return { ok: true };
      }),
    fetchPairing: async () => options.pairing ?? null,
  };

  return {
    module: createPairingModule(ports),
    accepted,
    unlinkCalls: () => unlinkCalls,
  };
}

/** A refusal carrying one of the stable pairing codes. */
function refusal(code: PairingError['code']) {
  return async () => ({ ok: false as const, error: { code, message: code } });
}

describe('payload mapping', () => {
  it('converts invitation ISO timestamps to epoch milliseconds', () => {
    const invitation = invitationFromPayload(invitationPayload());
    expect(invitation.createdAt).toBe(NOW);
    // Every expiry decision downstream depends on this conversion (Req 3.1, 3.5).
    expect(invitation.expiresAt - invitation.createdAt).toBe(SEVENTY_TWO_HOURS_MS);
  });

  it('converts pairing ISO timestamps to epoch milliseconds', () => {
    expect(pairingFromPayload(pairingPayload()).createdAt).toBe(NOW);
  });
});

describe('PairingModule.createInvitation', () => {
  it('returns an invitation valid for 72 hours (Req 3.1)', async () => {
    const result = await harness().module.createInvitation();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.code).toBe(CODE);
    expect(result.value.inviterAccountId).toBe(ALICE);
    expect(result.value.status).toBe('pending');
    expect(result.value.expiresAt - result.value.createdAt).toBe(SEVENTY_TWO_HOURS_MS);
  });

  it('surfaces ALREADY_PAIRED when the account is already in a pairing (Req 3.7)', async () => {
    const h = harness({ createInvitation: refusal(ERROR_CODES.ALREADY_PAIRED) });
    const result = await h.module.createInvitation();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
  });
});

describe('PairingModule.acceptInvitation', () => {
  it('returns the created pairing (Req 3.2)', async () => {
    const h = harness();
    const result = await h.module.acceptInvitation(CODE);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.status).toBe('active');
    expect([result.value.memberA, result.value.memberB]).toEqual([ALICE, BOB]);
    expect(h.accepted).toEqual([CODE]);
  });

  it('surfaces INVITATION_EXPIRED past the 72-hour window (Req 3.5)', async () => {
    const h = harness({ acceptInvitation: refusal(ERROR_CODES.INVITATION_EXPIRED) });
    const result = await h.module.acceptInvitation(CODE);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVITATION_EXPIRED);
  });

  it('surfaces INVITATION_ALREADY_CONSUMED on reuse (Req 3.8)', async () => {
    const h = harness({
      acceptInvitation: refusal(ERROR_CODES.INVITATION_ALREADY_CONSUMED),
    });
    const result = await h.module.acceptInvitation(CODE);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVITATION_ALREADY_CONSUMED);
  });

  it('surfaces ALREADY_PAIRED when the accepting account is paired (Req 3.3)', async () => {
    const h = harness({ acceptInvitation: refusal(ERROR_CODES.ALREADY_PAIRED) });
    const result = await h.module.acceptInvitation(CODE);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.ALREADY_PAIRED);
  });

  it('surfaces INVITATION_NOT_FOUND for an unknown code', async () => {
    const h = harness({ acceptInvitation: refusal(ERROR_CODES.INVITATION_NOT_FOUND) });
    const result = await h.module.acceptInvitation(toInvitationCode('nope'));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVITATION_NOT_FOUND);
  });
});

describe('PairingModule.unlink', () => {
  it('dissolves the pairing (Req 4.1, 4.3)', async () => {
    const h = harness();
    const result = await h.module.unlink();
    expect(isOk(result)).toBe(true);
    expect(h.unlinkCalls()).toBe(1);
  });

  it('surfaces NOT_PAIRED when there is no pairing to dissolve', async () => {
    const h = harness({ unlink: refusal(ERROR_CODES.NOT_PAIRED) });
    const result = await h.module.unlink();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.NOT_PAIRED);
  });
});

describe('PairingModule.getPairing', () => {
  it('returns null while unpaired', async () => {
    expect(await harness({ pairing: null }).module.getPairing()).toBeNull();
  });

  it('returns the active pairing with epoch timestamps', async () => {
    const pairing = await harness({ pairing: pairingPayload() }).module.getPairing();
    expect(pairing?.id).toBe('pairing-1');
    expect(pairing?.createdAt).toBe(NOW);
    expect(pairing?.status).toBe('active');
  });
});
