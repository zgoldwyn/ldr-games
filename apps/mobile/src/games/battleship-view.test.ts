import { describe, expect, it } from 'vitest';
import { accountId } from '@ldr/core';

import { battleshipStatus, battleshipTurnError } from './battleship-view';

const SELF = accountId('self');
const PARTNER = accountId('partner');

describe('battleship presentation', () => {
  it('explains placement, turns, and results in player language', () => {
    expect(
      battleshipStatus({
        sessionState: 'active',
        phase: 'placement',
        fleetSubmitted: false,
        myTurn: true,
        winner: null,
        self: SELF,
      }).title,
    ).toBe('Place your fleet');
    expect(
      battleshipStatus({
        sessionState: 'active',
        phase: 'playing',
        fleetSubmitted: true,
        myTurn: false,
        winner: null,
        self: SELF,
      }).title,
    ).toBe('Partner’s turn');
    expect(
      battleshipStatus({
        sessionState: 'terminal',
        phase: 'playing',
        fleetSubmitted: true,
        myTurn: false,
        winner: SELF,
        self: SELF,
      }).title,
    ).toBe('You won!');
    expect(
      battleshipStatus({
        sessionState: 'terminal',
        phase: 'playing',
        fleetSubmitted: true,
        myTurn: false,
        winner: PARTNER,
        self: SELF,
      }).title,
    ).toBe('Your partner won');
  });

  it('turns a rejected stale shot into an actionable explanation', () => {
    expect(
      battleshipTurnError({
        code: 'INVALID_TURN',
        phase: 'playing',
        myTurn: true,
        alreadyTargeted: true,
        terminal: false,
      }),
    ).toBe('You already targeted that square. Choose another one.');
    expect(
      battleshipTurnError({
        code: 'NOT_YOUR_TURN',
        phase: 'playing',
        myTurn: false,
        alreadyTargeted: false,
        terminal: false,
      }),
    ).toBe('Your partner is taking this turn.');
  });
});
