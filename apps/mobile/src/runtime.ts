import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createAsyncGameModule,
  createAuthenticationModule,
  createConnectionManager,
  createLocalStore,
  createNotificationModule,
  createPairingModule,
  createRealTimeGameModule,
  createSupabaseAsyncGamePorts,
  createSupabaseAuthPorts,
  createSupabaseConnectionPorts,
  createSupabaseNotificationPorts,
  createSupabasePairingPorts,
  createSupabaseRTGamePorts,
  createSupabaseSyncPorts,
  isOk,
  type AsyncGameModule,
  type ConnectionListeners,
  type ConnectionManager,
  type AuthenticationModule,
  type LocalStore,
  type NotificationModule,
  type Pairing,
  type PairingModule,
  type RealTimeGameModule,
  type Session,
} from '@ldr/core';

import { readSupabaseConfig } from './config';
import { createAuthStorage } from './session/auth-storage';
import { bulkKv, secureKv } from './session/expo-kv';
import { sessionGate, type SessionGate } from './session/session-gate';
import { createSessionStore } from './session/session-store';
import { hydrateStore, persistStore } from './session/store-persistence';

/** Live collaborators the screens call into. */
export interface AppRuntime {
  readonly client: SupabaseClient;
  readonly store: LocalStore;
  readonly auth: AuthenticationModule;
  readonly pairing: PairingModule;
  readonly rt: RealTimeGameModule;
  readonly asyncGames: AsyncGameModule;
  readonly notifications: NotificationModule;
  readonly connection: ConnectionManager;
}

export interface Identity {
  readonly gate: SessionGate;
  readonly session: Session | null;
  readonly pairing: Pairing | null;
}

export type RuntimeResult =
  | { readonly ok: true; readonly runtime: AppRuntime; readonly identity: Identity }
  | { readonly ok: false; readonly message: string };

/** Restore tokens, hydrate the cache, and decide which stack to show. */
export async function bootRuntime(
  listeners: ConnectionListeners = {},
): Promise<RuntimeResult> {
  const config = readSupabaseConfig();
  if (config === null) {
    return {
      ok: false,
      message:
        'Missing EXPO_PUBLIC_SUPABASE_ANON_KEY. The simulator talks to the local stack at 127.0.0.1:54321; copy the anon key from `supabase status`.',
    };
  }

  const client = createClient(config.url, config.anonKey, {
    auth: {
      storage: createAuthStorage(secureKv, bulkKv),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  const store = createLocalStore();
  await hydrateStore(store, bulkKv);
  for (const kind of ['rt_session', 'async_session', 'notification'] as const) {
    store.subscribe(kind, () => {
      void persistStore(store, bulkKv);
    });
  }

  const auth = createAuthenticationModule(
    createSupabaseAuthPorts(client, createSessionStore(secureKv)),
  );
  const pairing = createPairingModule(createSupabasePairingPorts(client));
  const rt = createRealTimeGameModule(createSupabaseRTGamePorts(client), store);
  const asyncGames = createAsyncGameModule(createSupabaseAsyncGamePorts(client), store);
  const notifications = createNotificationModule(
    createSupabaseNotificationPorts(client),
    {},
    store,
  );
  const connection = createConnectionManager({
    ports: createSupabaseConnectionPorts(client),
    syncPorts: createSupabaseSyncPorts(client),
    store,
    realTime: rt,
    async: asyncGames,
    listeners,
  });

  // Restores the access token so currentSession's registry read is authorized.
  await client.auth.getSession();

  const runtime: AppRuntime = {
    client,
    store,
    auth,
    pairing,
    rt,
    asyncGames,
    notifications,
    connection,
  };
  return { ok: true, runtime, identity: await loadIdentity(runtime) };
}

/** Re-read session + pairing after sign-in, accept, or sign-out. */
export async function loadIdentity(runtime: AppRuntime): Promise<Identity> {
  const sessionResult = await runtime.auth.currentSession();
  const session = isOk(sessionResult) ? sessionResult.value : null;
  const pairing = session === null ? null : await runtime.pairing.getPairing();
  return { session, pairing, gate: sessionGate(session, pairing) };
}
