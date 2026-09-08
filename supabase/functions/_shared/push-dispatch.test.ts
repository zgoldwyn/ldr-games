import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  dispatchExpoPush,
  isExpoPushToken,
  type PushNotification,
} from "./push-dispatch.ts";

const NOW = 1_800_000_000_000;
const notification: PushNotification = {
  id: "11111111-1111-4111-8111-111111111111",
  recipientAccountId: "22222222-2222-4222-8222-222222222222",
  category: "game_invite",
  createdAt: NOW - 1_000,
  acknowledgedAt: null,
};

Deno.test("recognizes current and legacy Expo push tokens", () => {
  assertEquals(isExpoPushToken("ExpoPushToken[value]"), true);
  assertEquals(isExpoPushToken("ExponentPushToken[value]"), true);
  assertFalse(isExpoPushToken("device-token"));
});

Deno.test("sends privacy-safe category copy and returns the Expo ticket", async () => {
  const requests: Request[] = [];
  const outcome = await dispatchExpoPush(
    notification,
    { disabledCategories: [], expoPushToken: "ExpoPushToken[value]" },
    NOW,
    {
      endpoint: "https://push.example.test/send",
      accessToken: "expo-secret",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({ data: { status: "ok", id: "ticket-1" } }),
        );
      },
    },
  );

  assertEquals(outcome, { status: "sent", ticketId: "ticket-1" });
  const request = requests[0];
  assertEquals(request?.headers.get("Authorization"), "Bearer expo-secret");
  assertEquals(await request?.json(), {
    to: "ExpoPushToken[value]",
    title: "Game invitation",
    body: "Your partner invited you to play.",
    sound: "default",
    data: {
      notificationId: notification.id,
      category: "game_invite",
    },
  });
});

Deno.test("disabled categories and missing tokens do not call Expo", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(Response.json({}));
  };

  assertEquals(
    await dispatchExpoPush(
      notification,
      {
        disabledCategories: ["game_invite"],
        expoPushToken: "ExpoPushToken[value]",
      },
      NOW,
      { fetch: fetcher },
    ),
    { status: "skipped", reason: "category_disabled" },
  );
  assertEquals(
    await dispatchExpoPush(
      notification,
      { disabledCategories: [], expoPushToken: null },
      NOW,
      { fetch: fetcher },
    ),
    { status: "skipped", reason: "no_token" },
  );
  assertEquals(calls, 0);
});

Deno.test("acknowledged and expired rows are never pushed", async () => {
  const settings = {
    disabledCategories: [],
    expoPushToken: "ExpoPushToken[value]",
  } as const;
  assertEquals(
    await dispatchExpoPush(
      { ...notification, acknowledgedAt: NOW },
      settings,
      NOW,
    ),
    { status: "skipped", reason: "acknowledged" },
  );
  assertEquals(
    await dispatchExpoPush(
      { ...notification, createdAt: NOW - 30 * 24 * 60 * 60 * 1_000 },
      settings,
      NOW,
    ),
    { status: "skipped", reason: "expired" },
  );
});

Deno.test("provider and transport failures remain best effort", async () => {
  const settings = {
    disabledCategories: [],
    expoPushToken: "ExpoPushToken[value]",
  } as const;
  assertEquals(
    await dispatchExpoPush(notification, settings, NOW, {
      fetch: () =>
        Promise.resolve(new Response("unavailable", { status: 503 })),
    }),
    { status: "failed", reason: "provider_rejected", providerStatus: 503 },
  );
  assertEquals(
    await dispatchExpoPush(notification, settings, NOW, {
      fetch: () => Promise.reject(new Error("offline")),
    }),
    { status: "failed", reason: "transport_error" },
  );
});
