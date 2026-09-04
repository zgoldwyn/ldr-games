import type { Session } from '@ldr/core';
import type { SessionStore } from '@ldr/core';

import { parseSession, serializeSession } from './session-codec';
import type { StringStore } from './string-store';

/** SecureStore key for the domain session (not the refresh token). */
export const SESSION_KEY = 'ldr.session';

/** {@link SessionStore} over an injected key-value backend. */
export function createSessionStore(kv: StringStore): SessionStore {
  return {
    async read(): Promise<Session | null> {
      return parseSession(await kv.getItem(SESSION_KEY));
    },
    async write(session: Session): Promise<void> {
      await kv.setItem(SESSION_KEY, serializeSession(session));
    },
    async clear(): Promise<void> {
      await kv.removeItem(SESSION_KEY);
    },
  };
}
