// Database Webhook target for best-effort mobile push (task 19.2).
//
// The notifications row remains the source of truth. This function re-reads it
// rather than trusting caller JSON, applies the recipient's category settings,
// and sends only generic lock-screen copy directly through APNs. A provider failure
// never deletes or acknowledges the row, so the in-app path can still deliver it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleCors } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import {
  createApnsProviderToken,
  dispatchApnsPush,
  isApnsEnvironment,
  isPushCategory,
  type PushCategory,
  type PushNotification,
} from "../_shared/push-dispatch.ts";
import { serviceClient } from "../_shared/supabase.ts";

interface WebhookPayload {
  readonly type: "INSERT";
  readonly table: "notifications";
  readonly schema: "public";
  readonly record: { readonly id: string };
  readonly old_record: null;
}

const APNS_TOKEN_REFRESH_MS = 50 * 60 * 1_000;
const TERMINAL_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);
let cachedProviderToken:
  | { readonly value: string; readonly issuedAt: number }
  | null = null;
let providerTokenInFlight: Promise<string> | null = null;

/** Reuse Apple's provider JWT for 50 minutes and coalesce concurrent refreshes. */
async function apnsProviderToken(now: number): Promise<string> {
  if (
    cachedProviderToken !== null &&
    now - cachedProviderToken.issuedAt < APNS_TOKEN_REFRESH_MS
  ) {
    return cachedProviderToken.value;
  }
  if (providerTokenInFlight !== null) return await providerTokenInFlight;

  providerTokenInFlight = createApnsProviderToken(
    {
      keyId: Deno.env.get("APNS_KEY_ID") ?? "",
      teamId: Deno.env.get("APNS_TEAM_ID") ?? "",
      privateKey: Deno.env.get("APNS_PRIVATE_KEY") ?? "",
    },
    now,
  ).then((value) => {
    cachedProviderToken = { value, issuedAt: now };
    return value;
  });
  try {
    return await providerTokenInFlight;
  } finally {
    providerTokenInFlight = null;
  }
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const record = candidate.record;
  return candidate.type === "INSERT" && candidate.table === "notifications" &&
    candidate.schema === "public" && candidate.old_record === null &&
    typeof record === "object" && record !== null &&
    typeof (record as Record<string, unknown>).id === "string";
}

/**
 * The Edge gateway verifies the bearer JWT before this function runs. Inspect
 * its role claim instead of comparing the raw key with an environment value,
 * which can drift when a hosted project's legacy keys are rotated.
 */
function isServiceRoleRequest(req: Request): boolean {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  const payload = token.split(".")[1];
  if (payload === undefined) return false;

  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { readonly role?: unknown };
    return claims.role === "service_role";
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "push accepts POST only.", 405);
  }
  if (!isServiceRoleRequest(req)) {
    return errorResponse(
      "UNAUTHENTICATED",
      "A valid webhook credential is required.",
      401,
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    payload = null;
  }
  if (!isWebhookPayload(payload)) {
    return errorResponse(
      "INVALID_WEBHOOK",
      "Expected an INSERT webhook for public.notifications.",
      400,
    );
  }

  const db = serviceClient();
  const { data: rawNotification, error: notificationError } = await db
    .from("notifications")
    .select("id, recipient_account_id, category, created_at, acknowledged_at")
    .eq("id", payload.record.id)
    .maybeSingle();
  if (notificationError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load the notification.",
      500,
    );
  }
  if (!rawNotification) {
    return errorResponse(
      "NOTIFICATION_NOT_FOUND",
      "Notification not found.",
      404,
    );
  }
  if (!isPushCategory(rawNotification.category)) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Notification category is invalid.",
      500,
    );
  }

  const { data: rawSettings, error: settingsError } = await db
    .from("notification_settings")
    .select("disabled_categories, apns_device_token, apns_environment")
    .eq("account_id", rawNotification.recipient_account_id)
    .maybeSingle();
  if (settingsError) {
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to load notification settings.",
      500,
    );
  }

  const notification: PushNotification = {
    id: rawNotification.id,
    recipientAccountId: rawNotification.recipient_account_id,
    category: rawNotification.category,
    createdAt: Date.parse(rawNotification.created_at),
    acknowledgedAt: rawNotification.acknowledged_at === null
      ? null
      : Date.parse(rawNotification.acknowledged_at),
  };
  const disabledCategories = (rawSettings?.disabled_categories ?? [])
    .filter(isPushCategory) as PushCategory[];
  const apnsEnvironment = isApnsEnvironment(rawSettings?.apns_environment)
    ? rawSettings.apns_environment
    : null;
  const outcome = await dispatchApnsPush(
    notification,
    {
      disabledCategories,
      apnsDeviceToken: rawSettings?.apns_device_token ?? null,
      apnsEnvironment,
    },
    Date.now(),
    {
      topic: Deno.env.get("APNS_TOPIC") ?? "com.ldrcompanion.app",
      providerToken: () => apnsProviderToken(Date.now()),
    },
  );

  // Apple says these responses identify a token that must no longer be used.
  // Match the failed value so a concurrent token rotation is never cleared.
  if (
    outcome.status === "failed" &&
    outcome.reason === "provider_rejected" &&
    outcome.providerReason !== undefined &&
    TERMINAL_TOKEN_REASONS.has(outcome.providerReason) &&
    rawSettings?.apns_device_token
  ) {
    await db
      .from("notification_settings")
      .update({
        apns_device_token: null,
        apns_environment: null,
        updated_at: new Date().toISOString(),
      })
      .eq("account_id", rawNotification.recipient_account_id)
      .eq("apns_device_token", rawSettings.apns_device_token);
  }

  // Provider failures are intentionally a 200: notification creation already
  // committed, and out-of-app delivery is best effort. The durable row remains
  // available to Realtime and the next authenticated session.
  return jsonResponse({ notificationId: notification.id, outcome });
});
