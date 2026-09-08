// Database Webhook target for best-effort mobile push (task 19.2).
//
// The notifications row remains the source of truth. This function re-reads it
// rather than trusting caller JSON, applies the recipient's category settings,
// and sends only generic lock-screen copy through Expo Push. A provider failure
// never deletes or acknowledges the row, so the in-app path can still deliver it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { handleCors } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/http.ts";
import {
  dispatchExpoPush,
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

function isWebhookPayload(value: unknown): value is WebhookPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const record = candidate.record;
  return candidate.type === "INSERT" && candidate.table === "notifications" &&
    candidate.schema === "public" && candidate.old_record === null &&
    typeof record === "object" && record !== null &&
    typeof (record as Record<string, unknown>).id === "string";
}

/** Database Webhooks authenticate with the service-role key. */
function isServiceRoleRequest(req: Request): boolean {
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return typeof expected === "string" && expected.length > 0 &&
    req.headers.get("Authorization") === `Bearer ${expected}`;
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
    .select("disabled_categories, expo_push_token")
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
  const outcome = await dispatchExpoPush(
    notification,
    {
      disabledCategories,
      expoPushToken: rawSettings?.expo_push_token ?? null,
    },
    Date.now(),
    {
      accessToken: Deno.env.get("EXPO_ACCESS_TOKEN"),
      endpoint: Deno.env.get("EXPO_PUSH_URL"),
    },
  );

  // Provider failures are intentionally a 200: notification creation already
  // committed, and out-of-app delivery is best effort. The durable row remains
  // available to Realtime and the next authenticated session.
  return jsonResponse({ notificationId: notification.id, outcome });
});
