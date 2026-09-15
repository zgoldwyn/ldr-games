import { describe, expect, it } from 'vitest';

import { battleshipResultAction } from './battleship-result-flow';

describe('Battleship result flow', () => {
  it('reveals immediately only when the terminal screen is already at the top', () => {
    expect(battleshipResultAction({ terminal: true, scrollY: 0, reducedMotion: false })).toBe(
      'reveal',
    );
    expect(battleshipResultAction({ terminal: true, scrollY: 240, reducedMotion: false })).toBe(
      'scroll',
    );
  });

  it('jumps to the top before revealing when reduced motion is enabled', () => {
    expect(battleshipResultAction({ terminal: true, scrollY: 240, reducedMotion: true })).toBe(
      'jump',
    );
    expect(battleshipResultAction({ terminal: false, scrollY: 240, reducedMotion: false })).toBe(
      'hide',
    );
  });
});
