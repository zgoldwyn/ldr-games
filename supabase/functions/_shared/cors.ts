// Shared CORS helpers for Edge Functions.
//
// This is infrastructure scaffolding (not domain logic). Later Edge Function
// tasks import these helpers so every function handles cross-origin preflight
// requests from the mobile and desktop shells consistently.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

/**
 * Returns a preflight `Response` for an OPTIONS request, or `null` if the
 * request is not a CORS preflight and should be handled normally.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
