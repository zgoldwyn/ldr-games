// Feature: ldr-companion-app, Property 25: Asynchronous session persists through inactivity
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  accountId,
  gameId,
  notificationId,
  pairingId,
  sessionId,
} from './common.js';
import type { AccountId, Timestamp } from './common.js';
import type { AsyncSession } from './game.js';
import type { Pairing } from './pairing.js';
import {
  TURN_NUDGE_THRESHOLD_MS,
  type AsyncTurnNotificationPayload,
  deriveTurnNudge,
  isAsyncSessionActive,
  isTurnNudgeDue,
} from './async-lifecycle.js';

/**
 * Property 25 (task 6.4) — Asynchronous session persists through inactivity.
 *
 * For *any* elapsed inactivity duration, an asynchronous game session that has
 * not reached a terminal state and whose pairing has not been dissolved remains
 * active; after 48 continuous hours of a pending turn a nudge notification is
 * produced for the Active_Turn_Holder and the session remains active (never
 * forfeited or terminated by inactivity).
 *
 * The lifecycle derivations are pure and clock-free (every time input is passed
 * explicitly), so we can generate an arbitrary "now", an arbitrary pending-turn
 * instant, and an arbitrary session/pairing status, then assert the invariants
 * hold across the whole input space rather than at a few hand-picked instants.
 *
 * Validates: Requirements 7.11, 7.12
 */

const HOLDER = accountId('holder');
const OTHER = accountId('other');

const holderArb: fc.Arbitrary<AccountId> = fc.constantFrom(HOLDER, OTHER);

/** A wide range of reference instants, from the epoch to the far future. */
const nowArb: fc.Arbitrary<Timestamp> = fc.integer({
  min: 0,
  max: 4_000_000_000_000,
});

/**
 * A non-negative elapsed inactivity duration spanning from zero to far beyond
 * the 48-hour nudge threshold (roughly a year), so the property exercises both
 * pre- and post-threshold behaviour as well as the exact boundary.
 */
const inactivityArb: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: TURN_NUDGE_THRESHOLD_MS * 200,
});

function makeSession(overrides: Partial<AsyncSession> = {}): AsyncSession {
  return {
    id: sessionId('s1'),
    pairingId: pairingId('p1'),
    gameId: gameId('battleship'),
    state: 'active',
    activeTurnHolder: HOLDER,
    turnPendingSince: 0,
    gameState: {},
    ...overrides,
  };
}

function makePairing(overrides: Partial<Pairing> = {}): Pairing {
  return {
    id: pairingId('p1'),
    memberA: HOLDER,
    memberB: OTHER,
    createdAt: 0,
    status: 'active',
    ...overrides,
  };
}

describe('Property 25: Asynchronous session persists through inactivity', () => {
  // Feature: ldr-companion-app, Property 25: Asynchronous session persists through inactivity
  // Validates: Requirements 7.11, 7.12
  it('a non-terminal session with an undissolved pairing stays active for any inactivity duration', () => {
    fc.assert(
      fc.property(
        nowArb,
        inactivityArb,
        holderArb,
        (now: Timestamp, inactivity: number, holder: AccountId) => {
          // The turn has been pending since `inactivity` ago; `now` is arbitrary.
          const turnPendingSince = now - inactivity;
          const session = makeSession({ activeTurnHolder: holder, turnPendingSince });
          const pairing = makePairing();

          // Req 7.11: no amount of inactivity ends an active, undissolved session.
          expect(isAsyncSessionActive(session, pairing)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 25: Asynchronous session persists through inactivity
  // Validates: Requirements 7.11, 7.12
  it('only a terminal state or a dissolved pairing can end the session', () => {
    fc.assert(
      fc.property(
        nowArb,
        inactivityArb,
        fc.constantFrom<AsyncSession['state']>('active', 'terminal'),
        fc.constantFrom<Pairing['status']>('active', 'dissolved'),
        (now, inactivity, state, status) => {
          const session = makeSession({ state, turnPendingSince: now - inactivity });
          const pairing = makePairing({ status });

          // Active iff the session is not terminal AND the pairing is not
          // dissolved — inactivity never appears in this decision.
          const expected = state !== 'terminal' && status !== 'dissolved';
          expect(isAsyncSessionActive(session, pairing)).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 25: Asynchronous session persists through inactivity
  // Validates: Requirements 7.11, 7.12
  it('produces a nudge for the holder at/after 48h pending, and the session still persists', () => {
    fc.assert(
      fc.property(
        nowArb,
        inactivityArb,
        holderArb,
        (now: Timestamp, inactivity: number, holder: AccountId) => {
          const turnPendingSince = now - inactivity;
          const session = makeSession({ activeTurnHolder: holder, turnPendingSince });
          const pairing = makePairing();

          const nudgeDue = inactivity >= TURN_NUDGE_THRESHOLD_MS;

          // Req 7.12: the nudge is due exactly when a turn has been pending for
          // at least 48 continuous hours.
          expect(isTurnNudgeDue(session, now)).toBe(nudgeDue);

          const nudge = deriveTurnNudge(session, now, notificationId('n1'));

          if (nudgeDue) {
            // A nudge is produced, addressed to the Active_Turn_Holder.
            expect(nudge).not.toBeNull();
            expect(nudge?.recipientAccountId).toBe(holder);
            expect(nudge?.category).toBe('async_turn');
            expect((nudge?.payload as AsyncTurnNotificationPayload).kind).toBe(
              'turn_reminder',
            );
          } else {
            expect(nudge).toBeNull();
          }

          // Req 7.11/7.12: deriving (or not deriving) a nudge never forfeits or
          // terminates the session — it remains active either way.
          expect(session.state).toBe('active');
          expect(isAsyncSessionActive(session, pairing)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: ldr-companion-app, Property 25: Asynchronous session persists through inactivity
  // Validates: Requirements 7.11, 7.12
  it('never nudges a terminal session regardless of how long a turn was pending', () => {
    fc.assert(
      fc.property(nowArb, inactivityArb, (now: Timestamp, inactivity: number) => {
        const session = makeSession({
          state: 'terminal',
          turnPendingSince: now - inactivity,
        });
        expect(isTurnNudgeDue(session, now)).toBe(false);
        expect(deriveTurnNudge(session, now, notificationId('n1'))).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
