import { describe, expect, it } from 'vitest';

import { GAME_ART, gameArtForTheme } from './game-art';

describe('theme-aware game art', () => {
  it('provides both game illustrations for every color theme', () => {
    expect(Object.keys(GAME_ART)).toEqual(['pink', 'lavender', 'mint', 'sky', 'butter']);

    for (const theme of Object.keys(GAME_ART) as (keyof typeof GAME_ART)[]) {
      expect(gameArtForTheme(theme).battleship).toBeTruthy();
      expect(gameArtForTheme(theme).ticTacToe).toBeTruthy();
    }
  });
});
