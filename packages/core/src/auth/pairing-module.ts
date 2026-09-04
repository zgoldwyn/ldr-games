/**
 * Client PairingModule (Requirements 3.1-3.8, 4.1, 4.3).
 *
 * The client half of the pairing path. Every rule that matters is enforced by
 * the server and already integration-tested (task 13.3): exclusivity comes from
 * the partial UNIQUE indexes on active membership, single-use consumption from
 * `SELECT ... FOR UPDATE` on the invitation row, and dissolution from the
 * `dissolve_pairing` transaction. This module deliberately re-derives none of
 * that — a client-side exclusivity check would be advisory at best and would
 * mask the database guard, which is exactly the masking that made an earlier
 * concurrency test vacuous (see the note on task 13.3).
 *
 * What it does own is the wire-to-domain conversion and error surfacing: the
 * Edge Functions speak ISO-8601 strings, the domain speaks epoch milliseconds,
 * and a shell branches on the stable {@link PairingError} codes.
 *
 * DEVIATION FROM design.md, deliberate: the design sketches
 * `acceptInvitation(code, now)`. The `now` parameter is dropped. The 72-hour
 * window (Req 3.5) is evaluated inside the acceptance transaction against the
 * database clock, so a client-supplied time would either be ignored (misleading)
 * or trusted (a way to accept an expired invitation).
 */
import type { AccountId, InvitationCode, PairingId } from '../domain/common.js';
import type {
  Invitation,
  InvitationStatus,
  Pairing,
  PairingStatus,
} from '../domain/pairing.js';
import type { PairingError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

/** An invitation as the `create-invitation` Edge Function returns it. */
export interface InvitationPayload {
  readonly code: string;
  readonly inviterAccountId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: string;
}

/** A pairing as the `accept-invitation` / `unlink` Edge Functions return it. */
export interface PairingPayload {
  readonly id: string;
  readonly memberA: string;
  readonly memberB: string;
  readonly createdAt: string;
  readonly status: string;
}

/**
 * Map an invitation payload to the domain {@link Invitation}.
 *
 * Exported and pure so the timestamp conversion is testable on its own: the
 * 72-hour window (Req 3.1) and the expiry rejection (Req 3.5) are both stated in
 * epoch milliseconds, so a wrong conversion here would misreport both.
 */
export function invitationFromPayload(payload: InvitationPayload): Invitation {
  return {
    code: payload.code as InvitationCode,
    inviterAccountId: payload.inviterAccountId as AccountId,
    createdAt: Date.parse(payload.createdAt),
    expiresAt: Date.parse(payload.expiresAt),
    status: payload.status as InvitationStatus,
  };
}

/** Map a pairing payload to the domain {@link Pairing}. */
export function pairingFromPayload(payload: PairingPayload): Pairing {
  return {
    id: payload.id as PairingId,
    memberA: payload.memberA as AccountId,
    memberB: payload.memberB as AccountId,
    createdAt: Date.parse(payload.createdAt),
    status: payload.status as PairingStatus,
  };
}

/** Outcome of `create-invitation` (Req 3.1, 3.7). */
export type CreateInvitationOutcome =
  | { readonly ok: true; readonly invitation: InvitationPayload }
  | { readonly ok: false; readonly error: PairingError };

/** Outcome of `accept-invitation` (Req 3.2-3.6, 3.8). */
export type AcceptInvitationOutcome =
  | { readonly ok: true; readonly pairing: PairingPayload }
  | { readonly ok: false; readonly error: PairingError };

/** Outcome of `unlink` (Req 4.1-4.6). */
export type UnlinkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PairingError };

/** Injected collaborators. Each is the narrowest thing the module needs. */
export interface PairingPorts {
  /** POST `create-invitation`. */
  readonly createInvitation: () => Promise<CreateInvitationOutcome>;
  /** POST `accept-invitation` with the supplied code. */
  readonly acceptInvitation: (code: string) => Promise<AcceptInvitationOutcome>;
  /** POST `unlink`, dissolving the caller's pairing. */
  readonly unlink: () => Promise<UnlinkOutcome>;
  /**
   * The caller's current pairing read through RLS, or null while unpaired.
   * Read rather than cached: a partner can unlink at any moment, and a cached
   * pairing would keep a shell showing shared features that RLS already refuses.
   */
  readonly fetchPairing: () => Promise<PairingPayload | null>;
}

export interface PairingModule {
  /** Issue a 72-hour, single-use invitation (Req 3.1, 3.7). */
  createInvitation(): Promise<Result<Invitation, PairingError>>;
  /** Accept an invitation, creating the pairing (Req 3.2-3.6, 3.8). */
  acceptInvitation(code: InvitationCode): Promise<Result<Pairing, PairingError>>;
  /** Dissolve the current pairing (Req 4.1-4.6). */
  unlink(): Promise<Result<void, PairingError>>;
  /** The current pairing, or null while unpaired. */
  getPairing(): Promise<Pairing | null>;
}

/** Build a pairing module over the given ports. */
export function createPairingModule(ports: PairingPorts): PairingModule {
  return {
    async createInvitation(): Promise<Result<Invitation, PairingError>> {
      const outcome = await ports.createInvitation();
      return outcome.ok
        ? ok(invitationFromPayload(outcome.invitation))
        : err(outcome.error);
    },

    async acceptInvitation(code: InvitationCode): Promise<Result<Pairing, PairingError>> {
      const outcome = await ports.acceptInvitation(code);
      return outcome.ok ? ok(pairingFromPayload(outcome.pairing)) : err(outcome.error);
    },

    async unlink(): Promise<Result<void, PairingError>> {
      const outcome = await ports.unlink();
      return outcome.ok ? ok(undefined) : err(outcome.error);
    },

    async getPairing(): Promise<Pairing | null> {
      const payload = await ports.fetchPairing();
      return payload === null ? null : pairingFromPayload(payload);
    },
  };
}
