import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateEmailFormat,
  validatePasswordPolicy,
} from './auth-validation.js';

describe('validatePasswordPolicy', () => {
  it('accepts a password meeting every criterion', () => {
    const result = validatePasswordPolicy('Abcdef1!ghij'); // 12 chars, all classes
    expect(result.valid).toBe(true);
    expect(result.unmetCriteria).toEqual([]);
  });

  it('accepts the maximum length boundary (128)', () => {
    const pw = 'Aa1!' + 'a'.repeat(PASSWORD_MAX_LENGTH - 4);
    expect(pw.length).toBe(PASSWORD_MAX_LENGTH);
    expect(validatePasswordPolicy(pw).valid).toBe(true);
  });

  it('reports length when just below the minimum (11 chars)', () => {
    const pw = 'Abcdef1!ghi'; // 11 chars, otherwise valid
    expect(pw.length).toBe(PASSWORD_MIN_LENGTH - 1);
    const result = validatePasswordPolicy(pw);
    expect(result.valid).toBe(false);
    expect(result.unmetCriteria).toEqual(['length']);
  });

  it('reports length when just above the maximum (129 chars)', () => {
    const pw = 'Aa1!' + 'a'.repeat(PASSWORD_MAX_LENGTH - 3); // 129 chars
    expect(pw.length).toBe(PASSWORD_MAX_LENGTH + 1);
    expect(validatePasswordPolicy(pw).unmetCriteria).toEqual(['length']);
  });

  it('reports each missing character-class criterion', () => {
    // 12 lowercase letters: missing uppercase, digit, nonAlphanumeric
    const result = validatePasswordPolicy('abcdefghijkl');
    expect(result.valid).toBe(false);
    expect(result.unmetCriteria).toEqual(['uppercase', 'digit', 'nonAlphanumeric']);
  });

  it('reports every criterion in stable order for an empty password (missing field)', () => {
    const result = validatePasswordPolicy('');
    expect(result.valid).toBe(false);
    expect(result.unmetCriteria).toEqual([
      'length',
      'uppercase',
      'lowercase',
      'digit',
      'nonAlphanumeric',
    ]);
  });

  it('treats absent (non-string) input as an empty password', () => {
    // Defensive: runtime callers may pass undefined/null.
    const result = validatePasswordPolicy(undefined as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.unmetCriteria).toContain('length');
  });
});

describe('validateEmailFormat', () => {
  it.each([
    'user@example.com',
    'first.last@sub.example.co.uk',
    'user+tag@example.org',
    'u@ex.io',
  ])('accepts valid address %s', (email) => {
    expect(validateEmailFormat(email)).toBe(true);
  });

  it.each([
    '',
    'plainaddress',
    '@example.com',
    'user@',
    'user@example',
    'user@@example.com',
    'user@.com',
    'user@example..com',
    'a..b@example.com',
    'user name@example.com',
    ' user@example.com',
    'user@example.com ',
  ])('rejects invalid address %j', (email) => {
    expect(validateEmailFormat(email)).toBe(false);
  });

  it('rejects addresses longer than the max length', () => {
    const local = 'a'.repeat(EMAIL_MAX_LENGTH);
    expect(validateEmailFormat(`${local}@example.com`)).toBe(false);
  });

  it('treats non-string input as invalid', () => {
    expect(validateEmailFormat(undefined as unknown as string)).toBe(false);
  });
});
