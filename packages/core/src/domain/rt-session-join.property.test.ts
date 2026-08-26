import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { isOk } from '../result.js';
import { accountId, gameId, pairingId, sessionId } from './common.js';
import type { GameState, RTSession } from './game.js';
import { JOIN_WINDOW_MS, type RTPairingMembers, joinSession } from './rt-session.js';

/**
 * Property 22 (task 5.4) — Real-time join transition produces identical active state.
 *
 * For any pending real-time session in which both partners are present within
 * the 60-second join window, {@link joinSession} transitions the session to
 * `active`, seeds it with the single authoritative `initialState`, and clears
 * the join deadline. Because there is exactly one authoritative session, both
 * partners necessarily observe an identical active state: the transition is a
 * pure function of its inputs, so joining is independent of which partner is
 * listed first in `present` (order-invariance models the two partners' views).
 */

// Feature: ldr-companion-app, Property 22: Real-time join transition produces identical active state

/** Distinct partner account ids for a pairing. */
const membersArb: fc.Arbitrary<RTPairingMembers> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 12 }),
    fc.string({ minLength: 1, maxLength: 12 }),
  )
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => ({ a: accountId(a), b: accountId(b) }));

/** An arbitrary game-specific initial state (an open record). */
const gameStateArb: fc.Arbitrary<GameState> = fc.dictionary(
  fc.string({ maxLength: 8 }),
  fc.oneof(fc.integer(), fc.string(), fc.boolean()),
  { maxKeys: 6 },
);

function makePendingSession(pendingSince: number): RTSession {
  return {
    id: sessionId('s1'),
    pairingId: pairingId('p1'),
    gameId: gameId('battleship'),
    state: 'pending',
    // A pending session has no meaningful game state yet; join seeds it.
    gameState: {},
    pendingSince,
  };
}

describe('rt-session join transition (property)', () => {
  // Validates: Requirements 6.3
  it('activates a pending session with identical initial state when both partners join within 60s', () => {
    fc.assert(
      fc.property(
        membersArb,
        gameStateArb,
        // invitation time
        fc.integer({ min: 0, max: 10_000_000 }),
        // join delay strictly inside the 60s window (inclusive of the boundary)
        fc.integer({ min: 0, max: JOIN_WINDOW_MS }),
        // extra bystanders that must not affect the both-present decision
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 4 }),
        // whether member `a` or member `b` is listed first in `present`
        fc.boolean(),
        (members, initialState, pendingSince, joinDelay, extras, aFirst) => {
          const session = makePendingSession(pendingSince);
          const now = pendingSince + joinDelay;

          const bystanders = extras.map((e) => accountId(e));
          const present = aFirst
            ? [members.a, members.b, ...bystanders]
            : [members.b, members.a, ...bystanders];

          const result = joinSession(session, present, members, initialState, now);

          // The join within the window succeeds.
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;
          const active = result.value;

          // Transitions to active and clears the join deadline (Req 6.3).
          expect(active.state).toBe('active');
          expect(active.pendingSince).toBeUndefined();

          // Seeds the single authoritative initial state.
          expect(active.gameState).toBe(initialState);
          expect(active.gameState).toStrictEqual(initialState);

          // Identity fields carry over unchanged.
          expect(active.id).toBe(session.id);
          expect(active.pairingId).toBe(session.pairingId);
          expect(active.gameId).toBe(session.gameId);

          // Order-invariance: both partners observe an identical active session
          // regardless of who is listed first in `present`.
          const swapped = aFirst
            ? [members.b, members.a, ...bystanders]
            : [members.a, members.b, ...bystanders];
          const other = joinSession(session, swapped, members, initialState, now);
          expect(isOk(other)).toBe(true);
          if (!isOk(other)) return;
          expect(other.value).toStrictEqual(active);
        },
      ),
      { numRuns: 100 },
    );
  });
});
