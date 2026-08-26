import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { type AccountId, accountId, pairingId, sessionId } from './common.js';
import type { Account } from './account.js';
import type { Pairing } from './pairing.js';
import {
  type ActiveSessionRef,
  type SessionKind,
  dissolvePairing,
} from './pairing-logic.js';

/**
 * Property 15 (task 10.7) — Dissolution terminates any active session.
 *
 * For any active pairing that owns one or more active game/quiz sessions,
 * {@link dissolvePairing} terminates every one of those sessions and produces a
 * session-ended notification for *both* former partners for each terminated
 * session (Req 4.6). Because the transition is a pure, deterministic function of
 * its inputs, both partners observe the identical set of terminations and
 * notifications.
 */

// Feature: ldr-companion-app, Property 15: Dissolution terminates any active session

/** Two distinct partner account ids. */
const membersArb: fc.Arbitrary<readonly [AccountId, AccountId]> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 1, maxLength: 12 }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => [accountId(a), accountId(b)] as const);

const sessionKindArb: fc.Arbitrary<SessionKind> = fc.constantFrom('realtime', 'async', 'quiz');

/** A non-empty set of active sessions with distinct session ids (Req 4.6). */
const activeSessionsArb: fc.Arbitrary<readonly ActiveSessionRef[]> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 })
  .chain((ids) =>
    fc.tuple(...ids.map(() => sessionKindArb)).map((kinds) =>
      ids.map((id, i): ActiveSessionRef => ({ sessionId: sessionId(id), kind: kinds[i] })),
    ),
  );

function makeAccount(id: AccountId, pairing: string): Account {
  return {
    id,
    email: `${id}@example.com`,
    pairingId: pairingId(pairing),
    createdAt: 0,
  };
}

function makePairing(memberA: AccountId, memberB: AccountId): Pairing {
  return {
    id: pairingId('pair-1'),
    memberA,
    memberB,
    createdAt: 0,
    status: 'active',
  };
}

interface SessionEndedPayload {
  readonly type: string;
  readonly pairingId: string;
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
}

describe('pairing dissolution terminates active sessions (property)', () => {
  // Validates: Requirements 4.6
  it('terminates every active session and notifies both partners per session', () => {
    fc.assert(
      fc.property(
        membersArb,
        activeSessionsArb,
        fc.integer({ min: 0, max: 10_000_000 }),
        ([memberAId, memberBId], activeSessions, now) => {
          const pairing = makePairing(memberAId, memberBId);
          const memberA = makeAccount(memberAId, pairing.id);
          const memberB = makeAccount(memberBId, pairing.id);

          const result = dissolvePairing({ pairing, memberA, memberB, activeSessions, now });

          // Dissolving an active pairing always succeeds.
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;
          const out = result.value;

          // The pairing is dissolved.
          expect(out.pairing.status).toBe('dissolved');

          // Every active session is terminated — exactly, and only, those given.
          const expectedIds = activeSessions.map((s) => s.sessionId);
          expect([...out.terminatedSessions].sort()).toStrictEqual([...expectedIds].sort());

          // A session-ended notification is produced for BOTH former partners for
          // each terminated session (Req 4.6).
          const sessionEnded = out.notifications.filter(
            (n) => (n.payload as SessionEndedPayload).type === 'session_ended',
          );
          // 2 recipients per terminated session.
          expect(sessionEnded).toHaveLength(activeSessions.length * 2);
          expect(sessionEnded.every((n) => n.category === 'system')).toBe(true);

          for (const session of activeSessions) {
            const forSession = sessionEnded.filter(
              (n) => (n.payload as SessionEndedPayload).sessionId === session.sessionId,
            );
            // Exactly one notification per partner for this session.
            expect(forSession).toHaveLength(2);
            const recipients = new Set(forSession.map((n) => n.recipientAccountId));
            expect(recipients.has(memberAId)).toBe(true);
            expect(recipients.has(memberBId)).toBe(true);
            // Payload carries the session identity for the client.
            for (const n of forSession) {
              const payload = n.payload as SessionEndedPayload;
              expect(payload.pairingId).toBe(pairing.id);
              expect(payload.sessionKind).toBe(session.kind);
            }
          }

          // Determinism: both partners drive the single authoritative transition,
          // so re-running it yields an identical result.
          const again = dissolvePairing({ pairing, memberA, memberB, activeSessions, now });
          expect(isOk(again)).toBe(true);
          if (!isOk(again)) return;
          expect(again.value).toStrictEqual(out);
        },
      ),
      { numRuns: 100 },
    );
  });
});
