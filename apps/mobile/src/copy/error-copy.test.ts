import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@ldr/core';

import { messageForError } from './error-copy';

describe('messageForError', () => {
  it('explains when a partner won a simultaneous move race', () => {
    expect(
      messageForError({
        code: ERROR_CODES.INVALID_MOVE,
        message: 'That card cannot be played on this pile.',
        details: { reason: 'partner_won_race' },
      }),
    ).toBe('Your partner beat you to that one.');
  });

  it('ignores the server message so it cannot reveal which field was wrong (Req 2.2)', () => {
    expect(
      messageForError({
        code: ERROR_CODES.AUTH_FAILED,
        message: 'server said the email was unknown',
      }),
    ).toBe('Invalid email or password.');
  });

  it('names every unmet password criterion (Req 1.3)', () => {
    const message = messageForError({
      code: ERROR_CODES.INVALID_PASSWORD,
      message: 'nope',
      details: { unmetCriteria: ['length', 'digit'] },
    });
    expect(message).toContain('12');
    expect(message).toContain('number');
  });

  it('maps pairing and game codes to stable copy', () => {
    expect(messageForError({ code: ERROR_CODES.INVITATION_EXPIRED, message: 'x' })).toMatch(
      /expired/i,
    );
    expect(messageForError({ code: ERROR_CODES.NOT_YOUR_TURN, message: 'x' })).toMatch(
      /not your turn/i,
    );
    expect(messageForError({ code: ERROR_CODES.INVALID_MOVE, message: 'x' })).toMatch(/move/i);
  });

  it('does not describe a transport failure as a missing game', () => {
    expect(
      messageForError({
        code: ERROR_CODES.SESSION_NOT_FOUND,
        message: 'The real-time game request failed.',
      }),
    ).toBe('Could not reach the game server. Check your connection and try again.');
  });

  it('maps quiz lifecycle errors to actionable copy', () => {
    expect(messageForError({ code: ERROR_CODES.QUIZ_SESSION_IN_PROGRESS, message: 'x' })).toMatch(
      /finish your current quiz/i,
    );
    expect(messageForError({ code: ERROR_CODES.WRONG_PHASE, message: 'x' })).toMatch(/refresh/i);
  });
});
