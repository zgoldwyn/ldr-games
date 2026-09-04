import { describe, expect, it } from 'vitest';

import { accountId, type Session } from '@ldr/core';

import { parseSession, serializeSession } from './session-codec';

const SESSION: Session = {
  accountId: accountId('11111111-1111-4111-8111-111111111111'),
  epoch: 4,
  client: { platform: 'mobile', device: "Zoe's iPhone" },
  issuedAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_100_000,
};

describe('session codec', () => {
  it('round-trips a session through JSON', () => {
    expect(parseSession(serializeSession(SESSION))).toEqual(SESSION);
  });

  it('returns null for missing, empty, or malformed storage', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession('')).toBeNull();
    expect(parseSession('{')).toBeNull();
    expect(parseSession('{"epoch":1}')).toBeNull();
  });
});
