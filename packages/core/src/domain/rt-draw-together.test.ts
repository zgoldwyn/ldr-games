import { describe, expect, it } from 'vitest';

import { accountId } from './common.js';
import { getRuleset } from './rt-engine.js';
import {
  DRAW_TOGETHER,
  beginDrawTogetherTurn,
  completeDrawTogetherTurn,
  createDrawTogetherState,
  drawTogetherPoints,
  drawTogetherMatchRemainingMs,
  drawTogetherWordMask,
  drawTogetherRemainingMs,
  isCorrectDrawTogetherGuess,
  isDrawTogetherState,
  normalizeDrawTogetherGuess,
  parseDrawTogetherMatchSeconds,
  startDrawTogetherMatch,
} from './rt-draw-together.js';

const A = accountId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = accountId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

describe('Draw Together scoring', () => {
  it('awards deterministic shared speed and difficulty points', () => {
    expect(drawTogetherPoints(60_000, 'easy')).toBe(200);
    expect(drawTogetherPoints(30_000, 'medium')).toBe(188);
    expect(drawTogetherPoints(10_000, 'hard')).toBe(174);
    expect(drawTogetherPoints(0, 'hard')).toBe(150);
  });

  it('clamps untrusted remaining time to one turn', () => {
    expect(drawTogetherPoints(90_000, 'easy')).toBe(200);
    expect(drawTogetherPoints(-1, 'easy')).toBe(100);
  });
});

describe('Draw Together guesses', () => {
  it('ignores case, accents, punctuation, spacing, and simple plurals', () => {
    expect(normalizeDrawTogetherGuess('  CAFÉS!! ')).toBe('cafe');
    expect(isCorrectDrawTogetherGuess('fire-trucks', 'Fire truck')).toBe(true);
    expect(isCorrectDrawTogetherGuess('BERRIES', 'berry')).toBe(true);
  });

  it('masks letters while preserving multi-word structure', () => {
    expect(drawTogetherWordMask('fire truck')).toBe('____ _____');
    expect(drawTogetherWordMask('  ice   cream ')).toBe('___ _____');
  });

  it('does not accept blanks or merely similar guesses', () => {
    expect(isCorrectDrawTogetherGuess(' ', '')).toBe(false);
    expect(isCorrectDrawTogetherGuess('cat', 'car')).toBe(false);
  });
});

describe('Draw Together public state', () => {
  it('starts with a shared zero score and no answer in shared state', () => {
    const state = createDrawTogetherState([A, B], A);
    expect(state.drawer).toBe(A);
    expect(state.guesser).toBe(B);
    expect(state.matchDurationSeconds).toBe(300);
    expect(state.score).toBe(0);
    expect(state.attempts).toEqual([]);
    expect('word' in state).toBe(false);
    expect(isDrawTogetherState(state)).toBe(true);
  });

  it('rejects a shared payload that accidentally contains the answer', () => {
    const leaked = { ...createDrawTogetherState([A, B], A), word: 'volcano' };
    expect(isDrawTogetherState(leaked)).toBe(false);
  });

  it('registers in the real-time catalog but rejects generic moves', () => {
    const ruleset = getRuleset(DRAW_TOGETHER);
    expect(ruleset?.name).toBe('Draw Together');
    const state = createDrawTogetherState([A, B], A);
    expect(ruleset?.applyMove(state, A, { type: 'guess', guess: 'cat' })).toMatchObject({
      ok: false,
    });
  });

  it('accepts only comparable match durations', () => {
    expect(parseDrawTogetherMatchSeconds(180)).toEqual({ ok: true, value: 180 });
    expect(parseDrawTogetherMatchSeconds(300)).toEqual({ ok: true, value: 300 });
    expect(parseDrawTogetherMatchSeconds(600)).toEqual({ ok: true, value: 600 });
    expect(parseDrawTogetherMatchSeconds(240)).toMatchObject({ ok: false });
  });

  it('derives display time from the server deadline', () => {
    expect(drawTogetherRemainingMs(10_000, 7_500)).toBe(2_500);
    expect(drawTogetherRemainingMs(10_000, 12_000)).toBe(0);
    expect(drawTogetherRemainingMs(null, 1)).toBe(0);
  });

  it('freezes the displayed match budget while a drawer chooses', () => {
    const started = startDrawTogetherMatch(createDrawTogetherState([A, B], A), 180, 1_000);
    if (!started.ok) throw new Error('expected match start');
    expect(drawTogetherMatchRemainingMs(started.value, 1_000)).toBe(180_000);
    expect(drawTogetherMatchRemainingMs(started.value, 7_000)).toBe(180_000);
  });
});

describe('Draw Together match transitions', () => {
  it('pauses the match budget during selection and resumes it for drawing', () => {
    const initial = createDrawTogetherState([A, B], A);
    const started = startDrawTogetherMatch(initial, 180, 1_000);
    expect(started).toMatchObject({
      ok: true,
      value: { phase: 'choosing', matchEndsAt: 181_000, choiceEndsAt: 9_000 },
    });
    if (!started.ok) throw new Error('expected match start');
    const drawing = beginDrawTogetherTurn(started.value, 'hard', '_______', 7_000);
    expect(drawing).toMatchObject({
      ok: true,
      value: {
        phase: 'drawing',
        matchEndsAt: 187_000,
        turnEndsAt: 67_000,
        maskedWordPattern: '_______',
        maskedWordLength: 7,
      },
    });
  });

  it('awards shared points, records the revealed word, and alternates roles', () => {
    const started = startDrawTogetherMatch(createDrawTogetherState([A, B], A), 300, 0);
    if (!started.ok) throw new Error('expected match start');
    const drawing = beginDrawTogetherTurn(started.value, 'medium', '_______', 1_000);
    if (!drawing.ok) throw new Error('expected drawing start');
    const completed = completeDrawTogetherTurn(drawing.value, {
      word: 'volcano',
      difficulty: 'medium',
      solved: true,
      now: 31_000,
    });
    expect(completed).toMatchObject({
      ok: true,
      value: {
        phase: 'choosing',
        drawer: B,
        guesser: A,
        score: 188,
        solvedCount: 1,
        turn: 1,
        attempts: [{ word: 'volcano', result: 'solved', points: 188 }],
      },
    });
  });

  it('records the active word as missed when the match expires', () => {
    const started = startDrawTogetherMatch(createDrawTogetherState([A, B], A), 180, 0);
    if (!started.ok) throw new Error('expected match start');
    const drawing = beginDrawTogetherTurn(started.value, 'easy', '___', 1_000);
    if (!drawing.ok) throw new Error('expected drawing start');
    const completed = completeDrawTogetherTurn(drawing.value, {
      word: 'cat',
      difficulty: 'easy',
      solved: false,
      now: 181_000,
    });
    expect(completed).toMatchObject({
      ok: true,
      value: {
        phase: 'finished',
        status: 'draw',
        attempts: [{ word: 'cat', result: 'missed', points: 0 }],
      },
    });
  });
});
