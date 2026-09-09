/** Pure/injected direct APNs dispatch used by the notification webhook. */

export const APNS_PRODUCTION_URL = "https://api.push.apple.com";
export const APNS_DEVELOPMENT_URL = "https://api.sandbox.push.apple.com";

export const PUSH_CATEGORIES = [
  "pairing",
  "game_invite",
  "async_turn",
  "reminder",
  "quiz",
  "system",
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];
export type ApnsEnvironment = "development" | "production";

export interface PushNotification {
  readonly id: string;
  readonly recipientAccountId: string;
  readonly category: PushCategory;
  readonly createdAt: number;
  readonly acknowledgedAt: number | null;
}

export interface PushSettings {
  readonly disabledCategories: readonly PushCategory[];
  readonly apnsDeviceToken: string | null;
  readonly apnsEnvironment: ApnsEnvironment | null;
}

export interface ApnsProviderCredentials {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKey: string;
}

export type PushDispatchOutcome =
  | { readonly status: "sent"; readonly apnsId: string | null }
  | {
    readonly status: "skipped";
    readonly reason:
      | "acknowledged"
      | "category_disabled"
      | "expired"
      | "no_token";
  }
  | {
    readonly status: "failed";
    readonly reason:
      | "provider_auth"
      | "provider_rejected"
      | "transport_error";
    readonly providerStatus?: number;
    readonly providerReason?: string;
  };

export interface PushDispatchOptions {
  readonly fetch?: typeof fetch;
  readonly endpointBase?: string;
  readonly topic: string;
  readonly providerToken: () => Promise<string>;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === "string" &&
    (PUSH_CATEGORIES as readonly string[]).includes(value);
}

/** Apple treats device tokens as opaque, variable-length byte sequences. */
export function isApnsDeviceToken(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2})+$/i.test(value);
}

export function isApnsEnvironment(value: unknown): value is ApnsEnvironment {
  return value === "development" || value === "production";
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function jsonBase64Url(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(pem: string): Uint8Array {
  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll(/\s/g, "");
  if (encoded.length === 0) throw new Error("Missing APNs private key.");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

/** Create Apple's ES256 provider JWT from the secret .p8 key. */
export async function createApnsProviderToken(
  credentials: ApnsProviderCredentials,
  now: number,
): Promise<string> {
  if (!credentials.keyId || !credentials.teamId) {
    throw new Error("Missing APNs provider identifiers.");
  }
  const header = jsonBase64Url({ alg: "ES256", kid: credentials.keyId });
  const claims = jsonBase64Url({
    iss: credentials.teamId,
    iat: Math.floor(now / 1_000),
  });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(credentials.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/** Fixed privacy-safe copy; private notification payloads stay in Supabase. */
export function pushMessage(
  notification: PushNotification,
): Record<string, unknown> {
  const copy: Record<PushCategory, { title: string; body: string }> = {
    pairing: {
      title: "Relationship update",
      body: "Open LDR Companion to see what changed.",
    },
    game_invite: {
      title: "Game invitation",
      body: "Your partner invited you to play.",
    },
    async_turn: {
      title: "Your turn",
      body: "A game is waiting for your move.",
    },
    reminder: {
      title: "Relationship reminder",
      body: "You have an upcoming relationship date.",
    },
    quiz: {
      title: "Quiz update",
      body: "Your shared quiz has an update.",
    },
    system: {
      title: "LDR Companion",
      body: "Open the app to see an update.",
    },
  };

  return {
    aps: { alert: copy[notification.category], sound: "default" },
    notificationId: notification.id,
    category: notification.category,
  };
}

/** Send one best-effort push directly to Apple without changing the durable row. */
export async function dispatchApnsPush(
  notification: PushNotification,
  settings: PushSettings,
  now: number,
  options: PushDispatchOptions,
): Promise<PushDispatchOutcome> {
  if (notification.acknowledgedAt !== null) {
    return { status: "skipped", reason: "acknowledged" };
  }
  if (now - notification.createdAt >= RETENTION_MS) {
    return { status: "skipped", reason: "expired" };
  }
  if (settings.disabledCategories.includes(notification.category)) {
    return { status: "skipped", reason: "category_disabled" };
  }
  if (
    !isApnsDeviceToken(settings.apnsDeviceToken) ||
    !isApnsEnvironment(settings.apnsEnvironment)
  ) {
    return { status: "skipped", reason: "no_token" };
  }

  let authorization: string;
  try {
    authorization = await options.providerToken();
  } catch {
    return { status: "failed", reason: "provider_auth" };
  }

  const defaultBase = settings.apnsEnvironment === "production"
    ? APNS_PRODUCTION_URL
    : APNS_DEVELOPMENT_URL;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${
        options.endpointBase ?? defaultBase
      }/3/device/${settings.apnsDeviceToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${authorization}`,
          "apns-topic": options.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": "0",
        },
        body: JSON.stringify(pushMessage(notification)),
      },
    );
  } catch {
    return { status: "failed", reason: "transport_error" };
  }

  if (!response.ok) {
    let providerReason: string | undefined;
    try {
      const body = await response.json() as { readonly reason?: unknown };
      if (typeof body.reason === "string") providerReason = body.reason;
    } catch {
      // APNs normally returns JSON, but status alone is still actionable.
    }
    return {
      status: "failed",
      reason: "provider_rejected",
      providerStatus: response.status,
      ...(providerReason === undefined ? {} : { providerReason }),
    };
  }
  return { status: "sent", apnsId: response.headers.get("apns-id") };
}
