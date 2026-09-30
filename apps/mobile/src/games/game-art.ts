import type { ColorOptionName } from '@ldr/core';

import battleshipButter from '../../assets/game-art/battleship-butter.png';
import battleshipLavender from '../../assets/game-art/battleship-lavender.png';
import battleshipMint from '../../assets/game-art/battleship-mint.png';
import battleshipPink from '../../assets/game-art/battleship-pink.png';
import battleshipSky from '../../assets/game-art/battleship-sky.png';
import couplesQuizButter from '../../assets/game-art/couples-quiz-butter.png';
import couplesQuizLavender from '../../assets/game-art/couples-quiz-lavender.png';
import couplesQuizMint from '../../assets/game-art/couples-quiz-mint.png';
import couplesQuizPink from '../../assets/game-art/couples-quiz-pink.png';
import couplesQuizSky from '../../assets/game-art/couples-quiz-sky.png';
import drawTogetherButter from '../../assets/game-art/draw-together-butter.png';
import drawTogetherLavender from '../../assets/game-art/draw-together-lavender.png';
import drawTogetherMint from '../../assets/game-art/draw-together-mint.png';
import drawTogetherPink from '../../assets/game-art/draw-together-pink.png';
import drawTogetherSky from '../../assets/game-art/draw-together-sky.png';
import ticTacToeButter from '../../assets/game-art/tic-tac-toe-butter.png';
import ticTacToeLavender from '../../assets/game-art/tic-tac-toe-lavender.png';
import ticTacToeMint from '../../assets/game-art/tic-tac-toe-mint.png';
import ticTacToePink from '../../assets/game-art/tic-tac-toe-pink.png';
import ticTacToeSky from '../../assets/game-art/tic-tac-toe-sky.png';

export interface GameArtSet {
  readonly battleship: number;
  readonly couplesQuiz: number;
  readonly drawTogether: number;
  readonly ticTacToe: number;
}

export const GAME_ART: Record<ColorOptionName, GameArtSet> = {
  pink: {
    battleship: battleshipPink,
    couplesQuiz: couplesQuizPink,
    drawTogether: drawTogetherPink,
    ticTacToe: ticTacToePink,
  },
  lavender: {
    battleship: battleshipLavender,
    couplesQuiz: couplesQuizLavender,
    drawTogether: drawTogetherLavender,
    ticTacToe: ticTacToeLavender,
  },
  mint: {
    battleship: battleshipMint,
    couplesQuiz: couplesQuizMint,
    drawTogether: drawTogetherMint,
    ticTacToe: ticTacToeMint,
  },
  sky: {
    battleship: battleshipSky,
    couplesQuiz: couplesQuizSky,
    drawTogether: drawTogetherSky,
    ticTacToe: ticTacToeSky,
  },
  butter: {
    battleship: battleshipButter,
    couplesQuiz: couplesQuizButter,
    drawTogether: drawTogetherButter,
    ticTacToe: ticTacToeButter,
  },
};

export function gameArtForTheme(theme: ColorOptionName): GameArtSet {
  return GAME_ART[theme];
}
