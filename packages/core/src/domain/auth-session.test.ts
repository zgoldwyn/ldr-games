import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../errors.js';
import { isErr, isOk } from '../result.js';
import { hashPassword, verifyPassword } from './auth-hashing.js';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_WINDOW_MS,
  computeLockout,
  type AuthAttemptEvent,
} from './auth-lockout.js';
import {
  INACTIVITY_LIMIT_MS,
  evaluateSession,
  isEpochCurrent,
  isWithinInactivityWindow,
} from './session-epoch.js';

const MINUTE = 60 * 1000;

describe('hashPassword / verifyPassword (Req 1.6)', () => {
  it('round-trips and never returns the plaintext', async () => {
    const password = 'Str0ng!Passw0rd';
    const hash = await hashPassword(password, 4); // low cost keeps the test fast
    expect(hash).not.toBe(password);
    expect(hash).not.toContain(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('rejects a wrong password and a malformed hash', async () => {
    const hash = await hashPassword('correct-horse', 4);
    expect(await verifyPassword('battery-staple', hash)).toBe(false);
    expect(await verifyPassword('correct-horse', 'not-a-hash')).toBe(false);
  });
});

describe('computeLockout (Req 2.3)', () => {
  const fails = (count: number, start: number, step: number): AuthAttemptEvent[] =>
    Array.from({ length: count }, (_, i) => ({ at: start + i * step, success: false }));

  it('locks after 5 consecutive failures within 15 minutes', () => {
    const attempts = fails(5, 0, MINUTE); // last failure at t=4min
    const status = computeLockout(attempts, 4 * MINUTE);
    expect(status.locked).toBe(true);
    expect(status.lockedUntil).toBe(4 * MINUTE + LOCKOUT_DURATION_MS);
  });

  it('does not lock with only 4 failures', () => {
    expect(computeLockout(fails(4, 0, MINUTE), 4 * MINUTE).locked).toBe(false);
  });

  it('does not lock when 5 failures span more than 15 minutes', () => {
    const attempts = fails(5, 0, 4 * MINUTE); // span = 16 minutes
    expect(computeLockout(attempts, 16 * MINUTE).locked).toBe(false);
  });

  it('a success resets the consecutive streak', () => {
    const attempts: AuthAttemptEvent[] = [
      ...fails(4, 0, MINUTE),
      { at: 4 * MINUTE, success: true },
      ...fails(4, 5 * MINUTE, MINUTE),
    ];
    expect(computeLockout(attempts, 9 * MINUTE).locked).toBe(false);
  });

  it('lock expires after the 15-minute duration', () => {
    const attempts = fails(5, 0, MINUTE);
    const afterExpiry = 4 * MINUTE + LOCKOUT_DURATION_MS + 1;
    expect(computeLockout(attempts, afterExpiry).locked).toBe(false);
  });

  it('window constant is 15 minutes', () => {
    expect(LOCKOUT_WINDOW_MS).toBe(15 * MINUTE);
  });
});

describe('session epoch + inactivity (Req 2.6, 2.7, 2.8)', () => {
  it('only the current epoch is valid', () => {
    expect(isEpochCurrent(3, 3)).toBe(true);
    expect(isEpochCurrent(2, 3)).toBe(false);
    expect(isEpochCurrent(4, 3)).toBe(false);
  });

  it('inactivity window is exclusive at 30 days', () => {
    const now = INACTIVITY_LIMIT_MS * 2;
    expect(isWithinInactivityWindow(now - (INACTIVITY_LIMIT_MS - 1), now)).toBe(true);
    expect(isWithinInactivityWindow(now - INACTIVITY_LIMIT_MS, now)).toBe(false);
  });

  it('evaluateSession reports superseded before expired', () => {
    const stale = evaluateSession({
      tokenEpoch: 1,
      currentEpoch: 2,
      lastActivityAt: 0,
      now: INACTIVITY_LIMIT_MS * 10,
    });
    expect(isErr(stale)).toBe(true);
    if (isErr(stale)) expect(stale.error.code).toBe(ERROR_CODES.SESSION_SUPERSEDED);
  });

  it('evaluateSession reports expiry for an inactive but current session', () => {
    const expired = evaluateSession({
      tokenEpoch: 2,
      currentEpoch: 2,
      lastActivityAt: 0,
      now: INACTIVITY_LIMIT_MS,
    });
    expect(isErr(expired)).toBe(true);
    if (isErr(expired)) expect(expired.error.code).toBe(ERROR_CODES.SESSION_EXPIRED);
  });

  it('evaluateSession accepts a current, active session', () => {
    const valid = evaluateSession({
      tokenEpoch: 2,
      currentEpoch: 2,
      lastActivityAt: 0,
      now: INACTIVITY_LIMIT_MS - 1,
    });
    expect(isOk(valid)).toBe(true);
  });
});
