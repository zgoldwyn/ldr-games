/**
 * Password hashing wrapper (Requirement 1.6).
 *
 * A thin, one-way password hash/verify wrapper over bcrypt. In production the
 * canonical password store is Supabase Auth (GoTrue), which already hashes with
 * bcrypt and never returns plaintext; this wrapper provides the same guarantee
 * for any core-side hashing needs (tests, tooling, and the register/verify Edge
 * Functions that share this module) so no code path ever persists or returns a
 * plaintext password.
 *
 * `bcryptjs` is a pure-JavaScript implementation, chosen for portability so the
 * identical code runs under Node (the shells), Deno (Edge Functions), and the
 * test runner without native build steps.
 *
 * These functions are intentionally NOT in the pure/deterministic evaluator set:
 * `hashPassword` draws a random salt, so the same input yields a different hash
 * each time. The invariant that matters — and that is property-tested — is the
 * round-trip: `verifyPassword(pw, await hashPassword(pw))` is always true, the
 * hash never equals the plaintext, and a wrong password never verifies.
 */
import bcrypt from 'bcryptjs';

/**
 * Default bcrypt cost factor (work factor / log rounds). 12 is a reasonable
 * balance of resistance and latency for interactive auth on current hardware.
 */
export const DEFAULT_BCRYPT_COST = 12;

/**
 * One-way hash a plaintext password with bcrypt, returning the encoded hash
 * string (which embeds the algorithm, cost, and salt). Never returns the
 * plaintext. Each call uses a fresh random salt, so output is non-deterministic.
 */
export async function hashPassword(
  plaintext: string,
  cost: number = DEFAULT_BCRYPT_COST,
): Promise<string> {
  return bcrypt.hash(plaintext, cost);
}

/**
 * Verify a plaintext password against a previously produced bcrypt hash.
 * Returns `true` iff the plaintext hashes (under the hash's embedded salt/cost)
 * to the given hash. A malformed hash yields `false` rather than throwing.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
