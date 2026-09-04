/**
 * Real `supabase-js` implementations of {@link AuthPorts} and
 * {@link PairingPorts} (Requirements 1.x, 2.x, 3.x, 4.x).
 *
 * Thin adapters, matching `sync/supabase-ports.ts` and
 * `notifications/supabase-ports.ts`: construct a request, invoke the Edge
 * Function, translate the response. Every decision worth testing lives in the
 * modules; the behaviour here is exercised end to end against a live stack.
 *
 * WHY THE ERROR BODY IS UNWRAPPED BY HAND. `functions.invoke` collapses any
 * non-2xx response into a `FunctionsHttpError` and discards the parsed body, but
 * the whole point of the server's `{ error: { code, message, details } }`
 * envelope is that a shell branches on `code`. The raw `Response` survives on
 * the error's `context`, so {@link readErrorEnvelope} reads it back. Without
 * this, `ALREADY_PAIRED` and `INVITATION_EXPIRED` would be indistinguishable
 * from a network failure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountId, ClientInfo, Session } from '../domain/common.js';
import {
  ERROR_CODES,
  type AuthErrorCode,
  type PairingErrorCode,
  type RegistrationErrorCode,
} from '../errors.js';
import type { AuthPorts, SessionRegistry } from './auth-module.js';
import type {
  InvitationPayload,
  PairingPayload,
  PairingPorts,
} from './pairing-module.js';

/** Secure, platform-provided storage for the established session. */
export interface SessionStore {
  /** Expo SecureStore on mobile; Electron `safeStorage`/OS keychain on desktop. */
  readonly read: () => Promise<Session | null>;
  readonly write: (session: Session) => Promise<void>;
  readonly clear: () => Promise<void>;
}

/** The `{ error: { code, message, details } }` envelope the functions emit. */
interface ErrorEnvelope {
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
async function readErrorEnvelope(error: unknown): Promise<ErrorEnvelope | null> {
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

const REGISTRATION_CODES: readonly string[] = [
  ERROR_CODES.EMAIL_ALREADY_REGISTERED,
  ERROR_CODES.INVALID_EMAIL_FORMAT,
  ERROR_CODES.INVALID_PASSWORD,
  ERROR_CODES.MISSING_REQUIRED_FIELD,
];

const AUTH_CODES: readonly string[] = [
  ERROR_CODES.AUTH_FAILED,
  ERROR_CODES.ACCOUNT_LOCKED,
  ERROR_CODES.MISSING_REQUIRED_FIELD,
];

const PAIRING_CODES: readonly string[] = [
  ERROR_CODES.ALREADY_PAIRED,
  ERROR_CODES.INVITATION_NOT_FOUND,
  ERROR_CODES.INVITATION_EXPIRED,
  ERROR_CODES.INVITATION_ALREADY_CONSUMED,
  ERROR_CODES.NOT_PAIRED,
];

/**
 * Narrow a server-supplied code to a known member of `known`, falling back
 * otherwise. An unrecognized code (a newer server, or an INTERNAL_ERROR) must
 * not leak into the typed vocabulary a shell switches on.
 */
function narrowCode<C extends string>(
  code: string | undefined,
  known: readonly string[],
  fallback: C,
): C {
  return code !== undefined && known.includes(code) ? (code as C) : fallback;
}

/**
 * Build {@link AuthPorts} over a Supabase client and platform secure storage.
 *
 * `client` starts unauthenticated: `register` and `auth-login` are the paths
 * that establish a session, and `adoptSession` is what installs it so every
 * later data and Realtime request runs as the account.
 */
export function createSupabaseAuthPorts(
  client: SupabaseClient,
  store: SessionStore,
): AuthPorts {
  return {
    async register(email, password) {
      const { data, error } = await client.functions.invoke<{
        data?: { accountId?: string };
      }>('register', { body: { email, password } });

      if (error) {
        const envelope = await readErrorEnvelope(error);
        return {
          ok: false,
          error: {
            // A transport failure is reported as a missing field rather than as
            // "email already registered", so a retry stays possible and the user
            // is never told their address is taken when it is not.
            code: narrowCode<RegistrationErrorCode>(
              envelope?.code,
              REGISTRATION_CODES,
              ERROR_CODES.MISSING_REQUIRED_FIELD,
            ),
            message: envelope?.message ?? 'Registration could not be completed.',
            ...(envelope?.details === undefined ? {} : { details: envelope.details }),
          },
        };
      }

      const accountId = data?.data?.accountId;
      if (accountId === undefined) {
        return {
          ok: false,
          error: {
            code: ERROR_CODES.MISSING_REQUIRED_FIELD,
            message: 'Registration returned no account id.',
          },
        };
      }
      return { ok: true, accountId: accountId as AccountId };
    },

    async login(email, password, clientInfo: ClientInfo) {
      const { data, error } = await client.functions.invoke<{
        epoch?: number;
        session?: { access_token?: string; refresh_token?: string };
        user?: { id?: string };
      }>('auth-login', { body: { email, password, client: clientInfo } });

      if (error) {
        const envelope = await readErrorEnvelope(error);
        return {
          ok: false,
          error: {
            // Req 2.2: anything that is not an explicit lockout is the uniform,
            // non-revealing failure.
            code: narrowCode<AuthErrorCode>(
              envelope?.code,
              AUTH_CODES,
              ERROR_CODES.AUTH_FAILED,
            ),
            message: envelope?.message ?? 'Invalid email or password.',
            ...(envelope?.details === undefined ? {} : { details: envelope.details }),
          },
        };
      }

      const epoch = data?.epoch;
      const accessToken = data?.session?.access_token;
      const refreshToken = data?.session?.refresh_token;
      const userId = data?.user?.id;
      if (
        epoch === undefined ||
        accessToken === undefined ||
        refreshToken === undefined ||
        userId === undefined
      ) {
        return {
          ok: false,
          error: {
            code: ERROR_CODES.AUTH_FAILED,
            message: 'Sign-in returned an incomplete session.',
          },
        };
      }

      return {
        ok: true,
        epoch,
        userId: userId as AccountId,
        accessToken,
        refreshToken,
      };
    },

    async adoptSession(accessToken, refreshToken) {
      await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    },

    async signOutRemote() {
      // The Edge Function bumps the epoch, which is what actually invalidates
      // the token everywhere (Req 2.4). The local `signOut` then drops the
      // client's copy so no further request is even attempted.
      await client.functions.invoke('auth-signout', { body: {} });
      await client.auth.signOut();
    },

    writePersistedSession: (session) => store.write(session),
    readPersistedSession: () => store.read(),
    clearPersistedSession: () => store.clear(),

    async fetchRegistry(accountId): Promise<SessionRegistry | null> {
      // Readable even on a stale epoch: the guard is deliberately omitted from
      // `account_session` so a displaced client can observe the newer epoch and
      // route itself to sign-in (Req 2.9).
      const { data, error } = await client
        .from('account_session')
        .select('epoch, last_activity_at')
        .eq('account_id', accountId)
        .maybeSingle();

      if (error || data === null) return null;

      const row = data as { epoch: number; last_activity_at: string | null };
      return {
        epoch: row.epoch,
        lastActivityAt:
          row.last_activity_at === null ? 0 : Date.parse(row.last_activity_at),
      };
    },

    now: () => Date.now(),
  };
}

/** Build {@link PairingPorts} over an authenticated Supabase client. */
export function createSupabasePairingPorts(client: SupabaseClient): PairingPorts {
  /** Shared refusal shape for the three Edge Function calls. */
  async function refusal(error: unknown, fallback: PairingErrorCode, fallbackMessage: string) {
    const envelope = await readErrorEnvelope(error);
    return {
      ok: false as const,
      error: {
        code: narrowCode<PairingErrorCode>(envelope?.code, PAIRING_CODES, fallback),
        message: envelope?.message ?? fallbackMessage,
        ...(envelope?.details === undefined ? {} : { details: envelope.details }),
      },
    };
  }

  return {
    async createInvitation() {
      const { data, error } = await client.functions.invoke<{
        invitation?: InvitationPayload;
      }>('create-invitation', { body: {} });

      if (error) {
        return await refusal(
          error,
          ERROR_CODES.ALREADY_PAIRED,
          'The invitation could not be created.',
        );
      }
      const invitation = data?.invitation;
      if (invitation === undefined) {
        return await refusal(
          null,
          ERROR_CODES.ALREADY_PAIRED,
          'The invitation could not be created.',
        );
      }
      return { ok: true, invitation };
    },

    async acceptInvitation(code: string) {
      const { data, error } = await client.functions.invoke<{
        pairing?: PairingPayload;
      }>('accept-invitation', { body: { code } });

      if (error) {
        return await refusal(
          error,
          ERROR_CODES.INVITATION_NOT_FOUND,
          'The invitation could not be accepted.',
        );
      }
      const pairing = data?.pairing;
      if (pairing === undefined) {
        return await refusal(
          null,
          ERROR_CODES.INVITATION_NOT_FOUND,
          'The invitation could not be accepted.',
        );
      }
      return { ok: true, pairing };
    },

    async unlink() {
      const { error } = await client.functions.invoke('unlink', { body: {} });
      if (error) {
        return await refusal(error, ERROR_CODES.NOT_PAIRED, 'The pairing could not be dissolved.');
      }
      return { ok: true };
    },

    async fetchPairing(): Promise<PairingPayload | null> {
      // Read through RLS rather than trusting a cached id: after a partner
      // unlinks, `accounts.pairing_id` is NULL and every pairing-scoped row is
      // already unreachable (Req 4.3, 4.4), so this is the honest answer.
      const { data, error } = await client
        .from('pairings')
        .select('id, member_a, member_b, created_at, status')
        .eq('status', 'active')
        .maybeSingle();

      if (error || data === null) return null;

      const row = data as {
        id: string;
        member_a: string;
        member_b: string;
        created_at: string;
        status: string;
      };
      return {
        id: row.id,
        memberA: row.member_a,
        memberB: row.member_b,
        createdAt: row.created_at,
        status: row.status,
      };
    },
  };
}
