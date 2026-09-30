import { describe, expect, it } from 'vitest';
import { accountId, createDrawTogetherState, type DrawTogetherState } from '@ldr/core';

import {
  drawTogetherClockLabel,
  drawTogetherMissedAttempts,
  drawTogetherPhaseCopy,
  drawTogetherResultTitle,
} from './draw-together-view';

const DRAWER = accountId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const GUESSER = accountId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

function state(overrides: Partial<DrawTogetherState> = {}): DrawTogetherState {
  return { ...createDrawTogetherState([DRAWER, GUESSER], DRAWER), ...overrides };
}

describe('Draw Together screen presentation', () => {
  it('formats master and turn timers without displaying negative time', () => {
    expect(drawTogetherClockLabel(180_000)).toBe('3:00');
    expect(drawTogetherClockLabel(60_001)).toBe('1:01');
    expect(drawTogetherClockLabel(-1)).toBe('0:00');
  });

  it('gives each partner role-appropriate choosing and drawing instructions', () => {
    const choosing = state({ phase: 'choosing' });
    expect(drawTogetherPhaseCopy(choosing, DRAWER)).toBe('Choose a word to draw.');
    expect(drawTogetherPhaseCopy(choosing, GUESSER)).toBe('Partner choosing a word…');
    expect(drawTogetherPhaseCopy(choosing, GUESSER, 'Sam')).toBe('Sam is choosing a word…');

    const drawing = state({ phase: 'drawing' });
    expect(drawTogetherPhaseCopy(drawing, DRAWER)).toBe(
      'Draw it clearly—your partner is guessing.',
    );
    expect(drawTogetherPhaseCopy(drawing, GUESSER)).toBe('Guess the drawing!');
    expect(drawTogetherPhaseCopy(drawing, DRAWER, 'Sam')).toBe('Draw it clearly—Sam is guessing.');
  });

  it('covers waiting, reveal, and finished messaging', () => {
    expect(drawTogetherPhaseCopy(state(), DRAWER)).toBe(
      'Choose a match length when your partner joins.',
    );
    expect(drawTogetherPhaseCopy(state({ phase: 'reveal' }), DRAWER)).toBe(
      'Get ready for the next word.',
    );
    expect(drawTogetherPhaseCopy(state({ phase: 'finished' }), DRAWER)).toBe('Time’s up!');
  });

  it('shows only missed words in the end-game recap', () => {
    const finished = state({
      phase: 'finished',
      attempts: [
        {
          turn: 0,
          drawer: DRAWER,
          word: 'volcano',
          difficulty: 'hard',
          result: 'missed',
          elapsedMs: 60_000,
          points: 0,
        },
        {
          turn: 1,
          drawer: GUESSER,
          word: 'cat',
          difficulty: 'easy',
          result: 'solved',
          elapsedMs: 10_000,
          points: 183,
        },
      ],
    });
    expect(drawTogetherMissedAttempts(finished).map((attempt) => attempt.word)).toEqual([
      'volcano',
    ]);
  });

  it('distinguishes a tied or beaten best score from an ordinary finish', () => {
    const finished = state({ phase: 'finished', score: 300 });
    expect(drawTogetherResultTitle(finished, 300)).toBe('New best score!');
    expect(drawTogetherResultTitle(finished, 301)).toBe('Nice work!');
    expect(drawTogetherResultTitle(finished, null)).toBe('Nice work!');
  });
});
