import type { Pairing, Session } from '@ldr/core';

/** Which stack the shell should present after restoring identity. */
export type SessionGate = 'signedOut' | 'unpaired' | 'ready';

/**
 * Map restored session + pairing onto a navigator. A dissolved pairing is
 * unpaired: RLS already hides the shared data (Req 4.3, 4.4), so the game list
 * must not linger on screen.
 */
export function sessionGate(session: Session | null, pairing: Pairing | null): SessionGate {
  if (session === null) return 'signedOut';
  if (pairing === null || pairing.status !== 'active') return 'unpaired';
  return 'ready';
}
