/** Pure/injected Expo Push dispatch used by the notification webhook. */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export const PUSH_CATEGORIES = [
  "pairing",
  "game_invite",
  "async_turn",
  "reminder",
  "quiz",
  "system",
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export interface PushNotification {
  readonly id: string;
  readonly recipientAccountId: string;
  readonly category: PushCategory;
  readonly createdAt: number;
  readonly acknowledgedAt: number | null;
}

export interface PushSettings {
  readonly disabledCategories: readonly PushCategory[];
  readonly expoPushToken: string | null;
}

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly sound: "default";
  readonly data: {
    readonly notificationId: string;
    readonly category: PushCategory;
  };
}

export type PushDispatchOutcome =
  | { readonly status: "sent"; readonly ticketId: string }
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
    readonly reason: "provider_error" | "provider_rejected" | "transport_error";
    readonly providerStatus?: number;
  };

export interface PushDispatchOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly accessToken?: string;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Narrow an untrusted database enum value before dispatch. */
export function isPushCategory(value: unknown): value is PushCategory {
  return typeof value === "string" &&
    (PUSH_CATEGORIES as readonly string[]).includes(value);
}

/** Expo supports the current and legacy token prefixes. */
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" &&
    /^(Expo|Exponent)PushToken\[[^\]\s]+\]$/.test(value);
}

/**
 * Use fixed copy by category. Notification payloads may contain relationship or
 * game details and must not be copied onto a lock screen by a server webhook.
 */
export function pushMessage(
  notification: PushNotification,
  token: string,
): ExpoPushMessage {
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
    to: token,
    ...copy[notification.category],
    sound: "default",
    data: {
      notificationId: notification.id,
      category: notification.category,
    },
  };
}

/** Send one best-effort push without changing the durable notification row. */
export async function dispatchExpoPush(
  notification: PushNotification,
  settings: PushSettings,
  now: number,
  options: PushDispatchOptions = {},
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
  if (!isExpoPushToken(settings.expoPushToken)) {
    return { status: "skipped", reason: "no_token" };
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      options.endpoint ?? EXPO_PUSH_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify(pushMessage(notification, settings.expoPushToken)),
      },
    );
  } catch {
    return { status: "failed", reason: "transport_error" };
  }

  if (!response.ok) {
    return {
      status: "failed",
      reason: "provider_rejected",
      providerStatus: response.status,
    };
  }

  try {
    const body = await response.json() as {
      readonly data?:
        | { readonly status?: unknown; readonly id?: unknown }
        | readonly { readonly status?: unknown; readonly id?: unknown }[];
    };
    const ticket = Array.isArray(body.data) ? body.data[0] : body.data;
    if (ticket?.status === "ok" && typeof ticket.id === "string") {
      return { status: "sent", ticketId: ticket.id };
    }
    return { status: "failed", reason: "provider_error" };
  } catch {
    return { status: "failed", reason: "provider_error" };
  }
}
