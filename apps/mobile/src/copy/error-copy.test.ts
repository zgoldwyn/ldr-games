import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@ldr/core';

import { messageForError } from './error-copy';

describe('messageForError', () => {
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
});
