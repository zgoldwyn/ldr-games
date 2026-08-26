/**
 * Property-based test for the password hash/verify wrapper (Requirement 1.6:
 * passwords are stored using a one-way cryptographic hash and the plaintext is
 * never stored or returned).
 *
 * bcrypt is deliberately slow at production cost factors, but the invariants
 * under test — round-trip correctness, rejection of a wrong password, and the
 * hash never leaking the plaintext — hold at ANY cost factor. So we run the
 * full spec-mandated minimum of 100 iterations at the bcrypt-minimum cost of 4
 * to keep the suite fast without weakening what the property proves.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { hashPassword, verifyPassword } from './auth-hashing.js';

// Low cost factor keeps 100 iterations (3 bcrypt ops each) practical; the
// properties are independent of the cost factor.
const TEST_COST = 4;

// Passwords drawn from printable characters, sized within the credential policy
// range (12–128) but capped at 72 bytes. bcrypt truncates input at 72 bytes, so
// keeping ASCII passwords <= 72 chars guarantees two distinct strings never
// collide on their significant prefix — making the "wrong password" assertion
// reliable rather than flaky.
const passwordArb = fc
  .string({ minLength: 12, maxLength: 72, unit: fc.constantFrom(...printableUnits()) })
  .filter((s) => s.length >= 12);

function printableUnits(): string[] {
  const units: string[] = [];
  for (let code = 0x21; code <= 0x7e; code += 1) units.push(String.fromCharCode(code));
  return units;
}

describe('password hashing (property)', () => {
  // Feature: ldr-companion-app, Property 4: Password hashing round-trip and secrecy
  it('hashes reversibly, rejects the wrong password, and never leaks the plaintext', async () => {
    await fc.assert(
      fc.asyncProperty(passwordArb, passwordArb, async (password, other) => {
        // Two distinct passwords; skip the (rare) collision so "other" is a
        // genuinely different credential.
        fc.pre(password !== other);

        const hash = await hashPassword(password, TEST_COST);

        // Round-trip: the same password always verifies against its hash.
        expect(await verifyPassword(password, hash)).toBe(true);

        // Rejection: a different password never verifies against the hash.
        expect(await verifyPassword(other, hash)).toBe(false);

        // Secrecy: the produced hash never contains the plaintext password.
        expect(hash.includes(password)).toBe(false);
      }),
    );
  });
});
