// Server-side Realtime Broadcast helper for Edge Functions.
//
// Infrastructure scaffolding (not domain logic). Sends a Broadcast message to a
// Realtime topic straight from server code via the Realtime HTTP broadcast
// endpoint, without opening a websocket. This is how the login function pushes
// the per-account "revoke" signal that displaces a previously signed-in client
// (Req 2.9): any client subscribed to `account:{id}` receives it and signs out
// locally.
import { supabaseUrl } from "./clients.ts";

/** A single Broadcast message addressed to a Realtime topic. */
export interface BroadcastMessage {
  /** Realtime topic (channel) name, e.g. `account:{accountId}`. */
  readonly topic: string;
  /** Broadcast event name, e.g. `revoke`. */
  readonly event: string;
  /** Arbitrary JSON payload delivered to subscribers. */
  readonly payload: Record<string, unknown>;
}

/**
 * Publishes Broadcast messages through the Realtime HTTP API using the
 * service-role key. Returns the HTTP `Response` so callers may inspect it;
 * delivery is best-effort (a missed signal is still covered by the epoch guard,
 * which rejects the stale token on its next request).
 */
export async function broadcast(
  serviceRoleKey: string,
  messages: readonly BroadcastMessage[],
): Promise<Response> {
  const url = `${supabaseUrl()}/realtime/v1/api/broadcast`;
  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ messages }),
  });
}
