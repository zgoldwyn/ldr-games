import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../errors.js';
import { accountId as toAccountId } from '../domain/common.js';
import { INACTIVITY_LIMIT_MS } from '../domain/session-epoch.js';
import { isErr, isOk } from '../result.js';
import {
  createAuthenticationModule,
  type AuthPorts,
  type LoginSuccess,
  type RegisterSuccess,
} from './auth-module.js';
import type { ClientInfo, Session } from '../domain/common.js';

// Unit tests for the client AuthenticationModule (Req 1.x, 2.1, 2.4, 2.5, 2.6, 2.9).
//
// Stub ports rather than a Supabase client: the module decides validation,
// session persistence, and currentSession routing. Edge Function contracts are
// already pinned in `__harness__/auth.integration.test.ts`.

const ALICE = toAccountId('11111111-1111-4111-8111-111111111111');
const NOW = 1_700_000_000_000;
const CLIENT: ClientInfo = { platform: 'mobile', device: "Zoe's iPhone" };
const VALID_EMAIL = 'zoe@example.com';
const VALID_PASSWORD = 'Sup3r!Secret42';

function okRegister(accountId = ALICE): RegisterSuccess {
  return { ok: true, accountId };
}

function okLogin(overrides: Partial<LoginSuccess> = {}): LoginSuccess {
  return {
    ok: true,
    epoch: 1,
    userId: ALICE,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function harness(options: {
  register?: AuthPorts['register'];
  login?: AuthPorts['login'];
  registry?: { epoch: number; lastActivityAt: number } | null;
} = {}) {
  let clock = NOW;
  let persisted: Session | null = null;
  const adopted: { accessToken: string; refreshToken: string }[] = [];
  let remoteSignOuts = 0;
  let localClears = 0;
  let registerCalls = 0;
  let loginCalls = 0;
  let registry = options.registry ?? { epoch: 1, lastActivityAt: NOW };

  const ports: AuthPorts = {
    register: async (email, password) => {
      registerCalls += 1;
      if (options.register) return options.register(email, password);
      return okRegister();
    },
    login: async (email, password, client) => {
      loginCalls += 1;
      if (options.login) return options.login(email, password, client);
      return okLogin();
    },
    adoptSession: async (accessToken, refreshToken) => {
      adopted.push({ accessToken, refreshToken });
    },
    signOutRemote: async () => {
      remoteSignOuts += 1;
    },
    writePersistedSession: async (session) => {
      persisted = session;
    },
    readPersistedSession: async () => persisted,
    clearPersistedSession: async () => {
      localClears += 1;
      persisted = null;
    },
    fetchRegistry: async () => registry,
    now: () => clock,
  };

  return {
    module: createAuthenticationModule(ports),
    adopted,
    registerCalls: () => registerCalls,
    loginCalls: () => loginCalls,
    remoteSignOuts: () => remoteSignOuts,
    localClears: () => localClears,
    persisted: () => persisted,
    setRegistry: (next: { epoch: number; lastActivityAt: number } | null) => {
      registry = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('AuthenticationModule.register', () => {
  it('rejects a missing email without calling the register port (Req 1.5)', async () => {
    const h = harness();
    const result = await h.module.register('', VALID_PASSWORD);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.MISSING_REQUIRED_FIELD);
    expect(result.error.details).toEqual({ fields: ['email'] });
    expect(h.registerCalls()).toBe(0);
  });

  it('rejects an invalid email format without calling the register port (Req 1.4)', async () => {
    const h = harness();
    const result = await h.module.register('not-an-email', VALID_PASSWORD);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVALID_EMAIL_FORMAT);
    expect(h.registerCalls()).toBe(0);
  });

  it('rejects a policy-failing password and reports each unmet criterion (Req 1.3)', async () => {
    const h = harness();
    const result = await h.module.register(VALID_EMAIL, 'short');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.INVALID_PASSWORD);
    expect(result.error.details?.unmetCriteria).toEqual(
      expect.arrayContaining(['length', 'uppercase', 'digit', 'nonAlphanumeric']),
    );
    expect(h.registerCalls()).toBe(0);
  });

  it('returns the new account id on success (Req 1.1)', async () => {
    const h = harness();
    const result = await h.module.register(VALID_EMAIL, VALID_PASSWORD);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toBe(ALICE);
    expect(h.registerCalls()).toBe(1);
  });

  it('surfaces EMAIL_ALREADY_REGISTERED from the register port (Req 1.2)', async () => {
    const h = harness({
      register: async () => ({
        ok: false,
        error: {
          code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
          message: 'That email address is already registered.',
        },
      }),
    });
    const result = await h.module.register(VALID_EMAIL, VALID_PASSWORD);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.EMAIL_ALREADY_REGISTERED);
  });
});

describe('AuthenticationModule.authenticate', () => {
  it('returns a session and adopts the issued tokens (Req 2.1)', async () => {
    const h = harness();
    const result = await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toEqual({
      accountId: ALICE,
      epoch: 1,
      client: CLIENT,
      issuedAt: NOW,
      lastActivityAt: NOW,
    });
    expect(h.adopted).toEqual([{ accessToken: 'access-token', refreshToken: 'refresh-token' }]);
    expect(h.persisted()?.accountId).toBe(ALICE);
  });

  it('returns AUTH_FAILED without revealing which field was wrong (Req 2.2)', async () => {
    const h = harness({
      login: async () => ({
        ok: false,
        error: { code: ERROR_CODES.AUTH_FAILED, message: 'Invalid email or password.' },
      }),
    });
    const result = await h.module.authenticate(VALID_EMAIL, 'wrong-password!!', CLIENT);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(h.adopted).toHaveLength(0);
  });

  it('returns ACCOUNT_LOCKED when the login port reports a lockout (Req 2.3)', async () => {
    const h = harness({
      login: async () => ({
        ok: false,
        error: {
          code: ERROR_CODES.ACCOUNT_LOCKED,
          message: 'locked',
          details: { lockedUntil: new Date(NOW + 15 * 60_000).toISOString() },
        },
      }),
    });
    const result = await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.ACCOUNT_LOCKED);
  });
});

describe('AuthenticationModule.currentSession', () => {
  it('returns UNAUTHENTICATED when there is no session so the shell can route to sign-in (Req 2.5)', async () => {
    const h = harness();
    const result = await h.module.currentSession();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
  });

  it('returns the session after a successful authenticate', async () => {
    const h = harness();
    await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    const result = await h.module.currentSession();
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.accountId).toBe(ALICE);
    expect(result.value.epoch).toBe(1);
  });

  it('returns SESSION_SUPERSEDED when the registry epoch has advanced (Req 2.9)', async () => {
    const h = harness();
    await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    h.setRegistry({ epoch: 2, lastActivityAt: NOW });
    const result = await h.module.currentSession();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.SESSION_SUPERSEDED);
  });

  it('returns SESSION_EXPIRED after 30 days of inactivity (Req 2.6)', async () => {
    const h = harness({ registry: { epoch: 1, lastActivityAt: NOW } });
    await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    h.advance(INACTIVITY_LIMIT_MS);
    const result = await h.module.currentSession();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.SESSION_EXPIRED);
  });
});

describe('AuthenticationModule.signOut', () => {
  it('terminates the remote session and clears the local one (Req 2.4, 2.5)', async () => {
    const h = harness();
    await h.module.authenticate(VALID_EMAIL, VALID_PASSWORD, CLIENT);
    await h.module.signOut();
    expect(h.remoteSignOuts()).toBe(1);
    expect(h.localClears()).toBe(1);
    const result = await h.module.currentSession();
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
  });
});
