// Health-check Edge Function.
//
// This is the skeleton Edge Function used to verify that the Deno edge runtime
// and the local Supabase stack are wired up correctly. Server-authoritative
// functions (registration, login/epoch hook, pairing, sync write-path, game and
// quiz transitions, scheduler jobs) are added in later tasks and follow the same
// Deno + supabase-js structure demonstrated here.
//
// Setup type definitions for built-in Supabase Runtime APIs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsHeaders, handleCors } from "../_shared/cors.ts";

Deno.serve((req: Request) => {
  // Browsers preflight cross-origin requests; short-circuit those.
  const preflight = handleCors(req);
  if (preflight) return preflight;

  return new Response(
    JSON.stringify({
      status: "ok",
      service: "ldr-companion-app edge functions",
      time: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});

/* To invoke locally once the stack is running:

  1. Run `npm run supabase:start` (wraps `supabase start`, requires Docker)
  2. Make an HTTP request:

  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/health'
*/
