import type { Session } from '@ldr/core';
import { accountId } from '@ldr/core';

function isPlatform(value: unknown): value is Session['client']['platform'] {
  return value === 'mobile' || value === 'desktop';
}

/** Serialize a domain {@link Session} for SecureStore. */
export function serializeSession(session: Session): string {
  return JSON.stringify(session);
}

/** Parse a stored session, or null when the blob is missing or not a Session. */
export function parseSession(raw: string | null): Session | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw) as Partial<Session>;
    if (typeof value.accountId !== 'string' || value.accountId.length === 0) return null;
    if (typeof value.epoch !== 'number') return null;
    if (value.client === undefined || !isPlatform(value.client.platform)) return null;
    if (typeof value.issuedAt !== 'number' || typeof value.lastActivityAt !== 'number') {
      return null;
    }
    return {
      accountId: accountId(value.accountId),
      epoch: value.epoch,
      client: {
        platform: value.client.platform,
        ...(typeof value.client.device === 'string' ? { device: value.client.device } : {}),
      },
      issuedAt: value.issuedAt,
      lastActivityAt: value.lastActivityAt,
    };
  } catch {
    return null;
  }
}
