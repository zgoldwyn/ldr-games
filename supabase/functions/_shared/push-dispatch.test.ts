import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createApnsProviderToken,
  dispatchApnsPush,
  isApnsDeviceToken,
  type PushNotification,
} from "./push-dispatch.ts";

const NOW = 1_800_000_000_000;
const DEVICE_TOKEN = "a".repeat(64);
const notification: PushNotification = {
  id: "11111111-1111-4111-8111-111111111111",
  recipientAccountId: "22222222-2222-4222-8222-222222222222",
  category: "game_invite",
  createdAt: NOW - 1_000,
  acknowledgedAt: null,
};

const options = {
  topic: "com.ldrcompanion.app",
  providerToken: () => Promise.resolve("provider-jwt"),
};

Deno.test("recognizes native APNs device tokens", () => {
  assertEquals(isApnsDeviceToken(DEVICE_TOKEN), true);
  assertEquals(isApnsDeviceToken("a1b2"), true);
  assertFalse(isApnsDeviceToken("ExpoPushToken[value]"));
  assertFalse(isApnsDeviceToken("abc"));
});

Deno.test("sends privacy-safe category copy directly to APNs", async () => {
  const requests: Request[] = [];
  const outcome = await dispatchApnsPush(
    notification,
    {
      disabledCategories: [],
      apnsDeviceToken: DEVICE_TOKEN,
      apnsEnvironment: "development",
    },
    NOW,
    {
      ...options,
      endpointBase: "https://push.example.test",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "apns-id": "delivery-1" },
          }),
        );
      },
    },
  );

  assertEquals(outcome, { status: "sent", apnsId: "delivery-1" });
  const request = requests[0];
  assertEquals(
    request?.url,
    `https://push.example.test/3/device/${DEVICE_TOKEN}`,
  );
  assertEquals(request?.headers.get("Authorization"), "bearer provider-jwt");
  assertEquals(request?.headers.get("apns-topic"), "com.ldrcompanion.app");
  assertEquals(await request?.json(), {
    aps: {
      alert: {
        title: "Game invitation",
        body: "Your partner invited you to play.",
      },
      sound: "default",
    },
    notificationId: notification.id,
    category: "game_invite",
  });
});

Deno.test("disabled categories and missing tokens do not call APNs", async () => {
  let calls = 0;
  const providerToken = () => {
    calls += 1;
    return Promise.resolve("provider-jwt");
  };

  assertEquals(
    await dispatchApnsPush(
      notification,
      {
        disabledCategories: ["game_invite"],
        apnsDeviceToken: DEVICE_TOKEN,
        apnsEnvironment: "development",
      },
      NOW,
      { ...options, providerToken },
    ),
    { status: "skipped", reason: "category_disabled" },
  );
  assertEquals(
    await dispatchApnsPush(
      notification,
      {
        disabledCategories: [],
        apnsDeviceToken: null,
        apnsEnvironment: null,
      },
      NOW,
      { ...options, providerToken },
    ),
    { status: "skipped", reason: "no_token" },
  );
  assertEquals(calls, 0);
});

Deno.test("acknowledged and expired rows are never pushed", async () => {
  const settings = {
    disabledCategories: [],
    apnsDeviceToken: DEVICE_TOKEN,
    apnsEnvironment: "production" as const,
  };
  assertEquals(
    await dispatchApnsPush(
      { ...notification, acknowledgedAt: NOW },
      settings,
      NOW,
      options,
    ),
    { status: "skipped", reason: "acknowledged" },
  );
  assertEquals(
    await dispatchApnsPush(
      { ...notification, createdAt: NOW - 30 * 24 * 60 * 60 * 1_000 },
      settings,
      NOW,
      options,
    ),
    { status: "skipped", reason: "expired" },
  );
});

Deno.test("provider-auth, rejection, and transport failures stay best effort", async () => {
  const settings = {
    disabledCategories: [],
    apnsDeviceToken: DEVICE_TOKEN,
    apnsEnvironment: "development" as const,
  };
  assertEquals(
    await dispatchApnsPush(notification, settings, NOW, {
      ...options,
      providerToken: () => Promise.reject(new Error("bad key")),
    }),
    { status: "failed", reason: "provider_auth" },
  );
  assertEquals(
    await dispatchApnsPush(notification, settings, NOW, {
      ...options,
      fetch: () =>
        Promise.resolve(
          Response.json({ reason: "BadDeviceToken" }, { status: 400 }),
        ),
    }),
    {
      status: "failed",
      reason: "provider_rejected",
      providerStatus: 400,
      providerReason: "BadDeviceToken",
    },
  );
  assertEquals(
    await dispatchApnsPush(notification, settings, NOW, {
      ...options,
      fetch: () => Promise.reject(new Error("offline")),
    }),
    { status: "failed", reason: "transport_error" },
  );
});

Deno.test("creates a verifiable ES256 APNs provider token", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateBytes = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(
      String.fromCharCode(...privateBytes),
    )
  }\n-----END PRIVATE KEY-----`;

  const token = await createApnsProviderToken(
    { keyId: "KEY123", teamId: "TEAM123", privateKey: pem },
    NOW,
  );
  const [header, claims, signature] = token.split(".");
  const decode = (value: string) =>
    JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
  assertEquals(decode(header), { alg: "ES256", kid: "KEY123" });
  assertEquals(decode(claims), {
    iss: "TEAM123",
    iat: Math.floor(NOW / 1_000),
  });
  const signatureBytes = Uint8Array.from(
    atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  assertEquals(signatureBytes.length, 64);
  assertEquals(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      signatureBytes,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    true,
  );
});
