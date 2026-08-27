// createInvitation Edge Function (Requirements 3.1, 3.7).
//
// Server-authoritative generation of a pairing invitation. An authenticated,
// currently-unpaired account may create a unique invitation that is valid for
// 72 hours (Req 3.1); an account that is already in a pairing is rejected with
// ALREADY_PAIRED (Req 3.7).
//
// The business rule ("reject if already paired") and the 72h expiry are decided
// by the PURE, shared logic in `@ldr/core` (`createInvitation` /
// `computeInvitationExpiry`), so the Edge Function only performs I/O: it loads
// the caller's account, runs the pure decision, and — on success — writes the
// resulting invitation row (uniqueness is additionally enforced by the UNIQUE
// constraint on `invitations.code`).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createInvitation } from "@ldr/core/pairing-logic";
import { handleCors } from "../_shared/cors.ts";
import {
  errorResponse,
  jsonResponse,
  statusForErrorCode,
} from "../_shared/http.ts";
import {
  authenticatedAccountId,
  serviceClient,
} from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "createInvitation must be called with POST.",
      405,
    );
  }

  // Resolve the authenticated caller (the prospective inviter).
  const inviterId = await authenticatedAccountId(req);
  if (!inviterId) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid authenticated session is required to create an invitation.",
      401,
    );
  }

  const db = serviceClient();

  // Load the inviter's account to read its current pairing state (the pure
  // logic rejects an already-paired inviter, Req 3.7).
  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("id, pairing_id, created_at")
    .eq("id", inviterId)
    .maybeSingle();

  if (accountErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the inviter account.",
      500,
    );
  }
  if (!account) {
    return errorResponse(
      "UNAUTHENTICATED",
      "The authenticated account no longer exists.",
      401,
    );
  }

  const now = Date.now();
  const input = {
    code: crypto.randomUUID(),
    inviter: {
      id: account.id,
      email: "",
      pairingId: account.pairing_id ?? null,
      createdAt: Date.parse(account.created_at) || now,
    },
    now,
  };

  // Pure decision: reject if already paired (Req 3.7) and compute expiry
  // (createdAt + 72h, Req 3.1 via computeInvitationExpiry).
  const decision = createInvitation(
    input as unknown as Parameters<typeof createInvitation>[0],
  );
  if (!decision.ok) {
    return errorResponse(
      decision.error.code,
      decision.error.message,
      statusForErrorCode(decision.error.code),
    );
  }

  const invitation = decision.value;

  // Persist the invitation. The DB UNIQUE constraint on `code` is the ultimate
  // guard for uniqueness (Req 3.1); status starts 'pending' (single-use, 3.8).
  const { error: insertErr } = await db.from("invitations").insert({
    code: invitation.code,
    inviter_account_id: invitation.inviterAccountId,
    created_at: new Date(invitation.createdAt).toISOString(),
    expires_at: new Date(invitation.expiresAt).toISOString(),
    status: "pending",
  });

  if (insertErr) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to persist the invitation.",
      500,
    );
  }

  return jsonResponse(
    {
      invitation: {
        code: invitation.code,
        inviterAccountId: invitation.inviterAccountId,
        createdAt: new Date(invitation.createdAt).toISOString(),
        expiresAt: new Date(invitation.expiresAt).toISOString(),
        status: invitation.status,
      },
    },
    201,
  );
});
