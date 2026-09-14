import { describe, expect, it } from 'vitest';

import { accountId } from '@ldr/core';

import {
  markForCell,
  markForPlayer,
  ticTacToeBoardLayout,
  ticTacToeStatus,
  winningCells,
} from './tic-tac-toe-view';

const A = accountId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = accountId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

describe('markForCell', () => {
  it('maps the first player to X and the second to O', () => {
    expect(markForCell(A, [A, B])).toBe('X');
    expect(markForCell(B, [A, B])).toBe('O');
    expect(markForCell(null, [A, B])).toBe('');
  });
});

describe('tic-tac-toe presentation', () => {
  it('calculates three explicit square cells for each supported phone width', () => {
    expect(ticTacToeBoardLayout(402)).toEqual({
      boardSize: 288,
      cellSize: 96,
    });
    expect(ticTacToeBoardLayout(440)).toEqual({
      boardSize: 288,
      cellSize: 96,
    });
    expect(ticTacToeBoardLayout(320)).toEqual({
      boardSize: 256,
      cellSize: 85.33333333333333,
    });
  });

  it('uses clear turn language instead of raw lifecycle values', () => {
    expect(
      ticTacToeStatus({
        sessionState: 'active',
        boardStatus: 'in_progress',
        currentTurn: A,
        winner: null,
        self: A,
      }),
    ).toEqual({ title: 'Your turn', detail: 'Choose any open square.' });
    expect(
      ticTacToeStatus({
        sessionState: 'active',
        boardStatus: 'in_progress',
        currentTurn: B,
        winner: null,
        self: A,
      }).title,
    ).toBe('Partner’s turn');
  });

  it('describes each terminal outcome without exposing the word terminal', () => {
    expect(
      ticTacToeStatus({
        sessionState: 'terminal',
        boardStatus: 'won',
        currentTurn: A,
        winner: A,
        self: A,
      }).title,
    ).toBe('You won!');
    expect(
      ticTacToeStatus({
        sessionState: 'terminal',
        boardStatus: 'won',
        currentTurn: A,
        winner: B,
        self: A,
      }).title,
    ).toBe('Your partner won');
    expect(
      ticTacToeStatus({
        sessionState: 'terminal',
        boardStatus: 'draw',
        currentTurn: A,
        winner: null,
        self: A,
      }).title,
    ).toBe('It’s a draw');
  });

  it('identifies the player mark and winning cells', () => {
    expect(markForPlayer(B, [A, B])).toBe('O');
    expect(winningCells([A, B, null, A, B, null, A, null, null])).toEqual([0, 3, 6]);
    expect(winningCells([A, B, null, null, null, null, null, null, null])).toEqual([]);
  });
});
