/**
 * Shared helpers for reading the Edge Functions' error envelope.
 *
 * WHY THE ERROR BODY IS UNWRAPPED BY HAND. `functions.invoke` collapses any
 * non-2xx response into a `FunctionsHttpError` and discards the parsed body, but
 * the whole point of the server's `{ error: { code, message, details } }`
 * envelope is that a shell branches on `code`. The raw `Response` survives on
 * the error's `context`, so {@link readErrorEnvelope} reads it back. Without
 * this, `ALREADY_PAIRED` and `NOT_YOUR_TURN` would be indistinguishable from a
 * network failure.
 *
 * This lives outside any one feature because every adapter that calls a function
 * needs it, and a second copy would be a second chance to get the `context`
 * unwrapping subtly wrong.
 */

/** The `{ error: { code, message, details } }` envelope the functions emit. */
export interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Recover the server's error envelope from a `functions.invoke` failure.
 *
 * Returns null when the failure carried no readable envelope — a transport
 * error, a gateway HTML page, or a non-JSON body — which callers report as their
 * own domain-appropriate fallback rather than inventing a code.
 */
export async function readErrorEnvelope(error: unknown): Promise<ErrorEnvelope | null> {
  const context = (error as { context?: unknown }).context;
  if (context === null || typeof context !== 'object') return null;

  const response = context as { json?: () => Promise<unknown> };
  if (typeof response.json !== 'function') return null;

  try {
    const body = (await response.json()) as { error?: ErrorEnvelope };
    return body?.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Narrow a server-supplied code to a known member of `known`, falling back
 * otherwise. An unrecognized code (a newer server, or an INTERNAL_ERROR) must
 * not leak into the typed vocabulary a shell switches on.
 */
export function narrowCode<C extends string>(
  code: string | undefined,
  known: readonly string[],
  fallback: C,
): C {
  return code !== undefined && known.includes(code) ? (code as C) : fallback;
}
