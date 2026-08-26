import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { EMAIL_MAX_LENGTH, validateEmailFormat } from './auth-validation.js';

// Feature: ldr-companion-app, Property 2: Email format validation
//
// For any string, registration is accepted only if the string is a
// syntactically valid email format, and any string not in valid email format is
// rejected. We split the universal claim into two smart generators: one that
// constructs only well-formed addresses (must always be accepted) and one that
// constructs only malformed addresses (must always be rejected).
//
// Validates: Requirements 1.4

// Local-part characters permitted by the dot-atom grammar, excluding '.' which
// is handled as the separator between atoms so no atom can produce "..".
const LOCAL_ATOM_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+/=?^_`{|}~-".split('');
// Characters that may start/end a DNS label.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');
// Characters permitted in the interior of a DNS label (hyphen allowed inside).
const LABEL_MID = [...ALNUM, '-'];

/** A single dot-atom of the local part (never empty, never contains a dot). */
const localAtom = fc.stringOf(fc.constantFrom(...LOCAL_ATOM_CHARS), {
  minLength: 1,
  maxLength: 8,
});

/** A local part: one or more atoms joined by single dots (no leading/trailing/consecutive dots). */
const localPart = fc
  .array(localAtom, { minLength: 1, maxLength: 4 })
  .map((atoms) => atoms.join('.'));

/** A single DNS label: 1 char, or first/last alphanumeric with an optional hyphenated interior. */
const domainLabel = fc.oneof(
  fc.constantFrom(...ALNUM),
  fc
    .tuple(
      fc.constantFrom(...ALNUM),
      fc.stringOf(fc.constantFrom(...LABEL_MID), { minLength: 0, maxLength: 10 }),
      fc.constantFrom(...ALNUM),
    )
    .map(([first, mid, last]) => `${first}${mid}${last}`),
);

/** A domain of at least two labels joined by dots (guarantees the required domain dot). */
const domain = fc
  .array(domainLabel, { minLength: 2, maxLength: 4 })
  .map((labels) => labels.join('.'));

/** A syntactically valid email within the length limit. */
const validEmail = fc
  .tuple(localPart, domain)
  .map(([local, dom]) => `${local}@${dom}`)
  .filter((email) => email.length <= EMAIL_MAX_LENGTH);

/** A collection of guaranteed-malformed addresses, each violating a distinct rule. */
const invalidEmail = fc.oneof(
  // Empty input.
  fc.constant(''),
  // No '@' at all (a bare local part).
  localPart,
  // '@' present but the domain has no dot (single label).
  fc.tuple(localPart, domainLabel).map(([local, label]) => `${local}@${label}`),
  // Leading whitespace around an otherwise-valid address.
  validEmail.map((email) => ` ${email}`),
  // Trailing whitespace around an otherwise-valid address.
  validEmail.map((email) => `${email} `),
  // Consecutive dots in the local part.
  fc.tuple(localPart, domain).map(([local, dom]) => `${local}..x@${dom}`),
  // Exceeds the maximum total length.
  fc
    .integer({ min: EMAIL_MAX_LENGTH + 1, max: EMAIL_MAX_LENGTH + 50 })
    .map((n) => `${'a'.repeat(n)}@example.com`),
);

describe('validateEmailFormat (Property 2: Email format validation)', () => {
  // Feature: ldr-companion-app, Property 2: Email format validation
  it('accepts every syntactically valid email', () => {
    fc.assert(
      fc.property(validEmail, (email) => {
        expect(validateEmailFormat(email)).toBe(true);
      }),
    );
  });

  // Feature: ldr-companion-app, Property 2: Email format validation
  it('rejects every malformed email', () => {
    fc.assert(
      fc.property(invalidEmail, (email) => {
        expect(validateEmailFormat(email)).toBe(false);
      }),
    );
  });
});
