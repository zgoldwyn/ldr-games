/**
 * Client AuthenticationModule (Requirements 1.1-1.5, 2.1, 2.2, 2.4, 2.5, 2.6, 2.9).
 *
 * The client half of the auth path. Every server-authoritative decision already
 * exists and is integration-tested: `register` (task 12.1) creates the account,
 * `auth-login` (12.2, 12.3) verifies credentials, records lockout and bumps the
 * single-session epoch, and `auth-signout` terminates the session. This module
 * does not re-implement any of that. It:
 *
 *   - Runs the shared pure validators BEFORE calling the network, so an obviously
 *     bad email or password is reported instantly and identically to the way the
 *     Edge Function would report it (Req 1.3, 1.4, 1.5). The server re-validates
 *     regardless; this is feedback, not enforcement.
 *   - Turns a successful login into a {@link Session} and hands the issued tokens
 *     to secure platform storage (Expo SecureStore / Electron safeStorage).
 *   - Answers `currentSession` by evaluating the local session against the
 *     account's registry row with the shared `evaluateSession`, so a displaced
 *     (Req 2.9) or 30-day-inactive (Req 2.6) session is reported as such and the
 *     shell can route to sign-in (Req 2.5).
 *
 * Collaborators are injected as narrow ports, matching `sync/sync-module.ts` and
 * `notifications/notification-module.ts`. That keeps the routing decisions
 * testable without a stack and lets task 21.3 compose this into the Connection
 * Manager. `createSupabaseAuthPorts` builds the real ports.
 *
 * OUT OF SCOPE, by design: reacting to the per-account `revoke` broadcast is the
 * Connection Manager's job (task 21.3). This module answers the question "is my
 * session still valid?" when asked; it does not listen for the answer changing.
 */
import type { AccountId, ClientInfo, Session, Timestamp } from '../domain/common.js';
import { validateEmailFormat, validatePasswordPolicy } from '../domain/auth-validation.js';
import { evaluateSession } from '../domain/session-epoch.js';
import {
  ERROR_CODES,
  type AuthError,
  type RegistrationError,
  type SessionError,
} from '../errors.js';
import { err, ok, type Result } from '../result.js';

/** The `register` Edge Function accepted the request and created the account. */
export interface RegisterSuccess {
  readonly ok: true;
  readonly accountId: AccountId;
}

/** The `register` Edge Function refused, carrying a stable registration code. */
export interface RegisterFailure {
  readonly ok: false;
  readonly error: RegistrationError;
}

export type RegisterOutcome = RegisterSuccess | RegisterFailure;

/**
 * A successful `auth-login` response. `epoch` is the account's NEW session epoch
 * and the tokens already carry it as a claim, so they satisfy the RLS epoch
 * guard (Req 2.7, 2.8).
 */
export interface LoginSuccess {
  readonly ok: true;
  readonly epoch: number;
  readonly userId: AccountId;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * A refused login. The code is `AUTH_FAILED` for any credential failure — the
 * function deliberately does not reveal which field was wrong (Req 2.2) — or
 * `ACCOUNT_LOCKED` after 5 failures in 15 minutes (Req 2.3).
 */
export interface LoginFailure {
  readonly ok: false;
  readonly error: AuthError;
}

export type LoginOutcome = LoginSuccess | LoginFailure;

/** The account's single-session registry row, as `currentSession` needs it. */
export interface SessionRegistry {
  readonly epoch: number;
  readonly lastActivityAt: Timestamp;
}

/** Injected collaborators. Each is the narrowest thing the module needs. */
export interface AuthPorts {
  /** POST the `register` Edge Function (Req 1.1, 1.2). */
  readonly register: (email: string, password: string) => Promise<RegisterOutcome>;

  /** POST the `auth-login` Edge Function (Req 2.1, 2.2, 2.3, 2.7-2.9). */
  readonly login: (
    email: string,
    password: string,
    client: ClientInfo,
  ) => Promise<LoginOutcome>;

  /**
   * Install the issued tokens on the underlying Supabase client so subsequent
   * data and Realtime requests run as this account.
   */
  readonly adoptSession: (accessToken: string, refreshToken: string) => Promise<void>;

  /** POST `auth-signout`, terminating the session server-side (Req 2.4). */
  readonly signOutRemote: () => Promise<void>;

  /** Persist the session to secure platform storage. */
  readonly writePersistedSession: (session: Session) => Promise<void>;
  /** The session restored from secure storage, or null when signed out. */
  readonly readPersistedSession: () => Promise<Session | null>;
  /** Drop the persisted session (sign-out). */
  readonly clearPersistedSession: () => Promise<void>;

  /**
   * The account's `account_session` row. Readable by the account itself even on
   * a stale epoch — the guard is deliberately omitted from that table so a
   * displaced client can observe its own displacement (Req 2.9).
   */
  readonly fetchRegistry: (accountId: AccountId) => Promise<SessionRegistry | null>;

  readonly now: () => Timestamp;
}

export interface AuthenticationModule {
  /** Create an account, validating locally before the network call (Req 1.x). */
  register(email: string, password: string): Promise<Result<AccountId, RegistrationError>>;
  /** Sign in, establishing the single active session (Req 2.1, 2.7, 2.8). */
  authenticate(
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<Result<Session, AuthError>>;
  /** Terminate the session locally and remotely (Req 2.4, 2.5). */
  signOut(): Promise<void>;
  /** The session if it is still valid, else why it is not (Req 2.5, 2.6, 2.9). */
  currentSession(): Promise<Result<Session, SessionError>>;
}

/** Build an authentication module over the given ports. */
export function createAuthenticationModule(ports: AuthPorts): AuthenticationModule {
  return {
    async register(
      email: string,
      password: string,
    ): Promise<Result<AccountId, RegistrationError>> {
      // Req 1.5: name every missing field rather than failing on the first.
      const missing: string[] = [];
      if (email.length === 0) missing.push('email');
      if (password.length === 0) missing.push('password');
      if (missing.length > 0) {
        return err({
          code: ERROR_CODES.MISSING_REQUIRED_FIELD,
          message: 'Email and password are required.',
          details: { fields: missing },
        });
      }

      if (!validateEmailFormat(email)) {
        return err({
          code: ERROR_CODES.INVALID_EMAIL_FORMAT,
          message: 'The email address format is invalid.',
        });
      }

      // Req 1.3: report every unmet criterion, not just the first.
      const policy = validatePasswordPolicy(password);
      if (!policy.valid) {
        return err({
          code: ERROR_CODES.INVALID_PASSWORD,
          message: 'The password does not meet the required policy.',
          details: { unmetCriteria: policy.unmetCriteria },
        });
      }

      const outcome = await ports.register(email, password);
      return outcome.ok ? ok(outcome.accountId) : err(outcome.error);
    },

    async authenticate(
      email: string,
      password: string,
      client: ClientInfo,
    ): Promise<Result<Session, AuthError>> {
      // No local credential validation here, deliberately. Req 2.2 requires a
      // uniform failure, and rejecting a malformed email client-side would tell
      // an attacker something the server refuses to.
      const outcome = await ports.login(email, password, client);
      if (!outcome.ok) return err(outcome.error);

      await ports.adoptSession(outcome.accessToken, outcome.refreshToken);

      const now = ports.now();
      const session: Session = {
        accountId: outcome.userId,
        epoch: outcome.epoch,
        client,
        issuedAt: now,
        lastActivityAt: now,
      };
      await ports.writePersistedSession(session);
      return ok(session);
    },

    async signOut(): Promise<void> {
      // Remote first, then local. If the remote call fails the local session is
      // still cleared: leaving a client believing it is signed in when the user
      // asked to leave is the worse failure, and the epoch guard means a token
      // we cannot revoke is refused as soon as anyone signs in again.
      try {
        await ports.signOutRemote();
      } finally {
        await ports.clearPersistedSession();
      }
    },

    async currentSession(): Promise<Result<Session, SessionError>> {
      const session = await ports.readPersistedSession();
      if (session === null) {
        // Req 2.5: no session -> deny shared features and route to sign-in.
        return err({
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'No authenticated session.',
        });
      }

      const registry = await ports.fetchRegistry(session.accountId);
      if (registry === null) {
        // The registry row is gone (or unreadable), so nothing backs this
        // session. Treated as signed out rather than as a transient error.
        return err({
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'No session registry entry for this account.',
        });
      }

      // Shared evaluator, so the client reaches the same verdict as the server:
      // a stale epoch is SESSION_SUPERSEDED (Req 2.9), 30 days idle is
      // SESSION_EXPIRED (Req 2.6).
      const validity = evaluateSession({
        tokenEpoch: session.epoch,
        currentEpoch: registry.epoch,
        lastActivityAt: registry.lastActivityAt,
        now: ports.now(),
      });
      if (!validity.ok) return err(validity.error);

      return ok({ ...session, lastActivityAt: registry.lastActivityAt });
    },
  };
}
