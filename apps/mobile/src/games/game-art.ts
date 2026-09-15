import type { ColorOptionName } from '@ldr/core';

import battleshipButter from '../../assets/game-art/battleship-butter.png';
import battleshipLavender from '../../assets/game-art/battleship-lavender.png';
import battleshipMint from '../../assets/game-art/battleship-mint.png';
import battleshipPink from '../../assets/game-art/battleship-pink.png';
import battleshipSky from '../../assets/game-art/battleship-sky.png';
import ticTacToeButter from '../../assets/game-art/tic-tac-toe-butter.png';
import ticTacToeLavender from '../../assets/game-art/tic-tac-toe-lavender.png';
import ticTacToeMint from '../../assets/game-art/tic-tac-toe-mint.png';
import ticTacToePink from '../../assets/game-art/tic-tac-toe-pink.png';
import ticTacToeSky from '../../assets/game-art/tic-tac-toe-sky.png';

export interface GameArtSet {
  readonly battleship: number;
  readonly ticTacToe: number;
}

export const GAME_ART: Record<ColorOptionName, GameArtSet> = {
  pink: { battleship: battleshipPink, ticTacToe: ticTacToePink },
  lavender: { battleship: battleshipLavender, ticTacToe: ticTacToeLavender },
  mint: { battleship: battleshipMint, ticTacToe: ticTacToeMint },
  sky: { battleship: battleshipSky, ticTacToe: ticTacToeSky },
  butter: { battleship: battleshipButter, ticTacToe: ticTacToeButter },
};

export function gameArtForTheme(theme: ColorOptionName): GameArtSet {
  return GAME_ART[theme];
}
