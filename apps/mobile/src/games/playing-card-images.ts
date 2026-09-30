/* eslint-disable @typescript-eslint/no-require-imports -- Metro needs static asset paths to bundle every card. */
import type { ImageSourcePropType } from 'react-native';
import type { SpeedCard, SpeedSuit } from '@ldr/core';

const CARD_IMAGES: Readonly<Record<SpeedSuit, readonly ImageSourcePropType[]>> = {
  clubs: [
    require('../../assets/cards/clubs-1.png'),
    require('../../assets/cards/clubs-2.png'),
    require('../../assets/cards/clubs-3.png'),
    require('../../assets/cards/clubs-4.png'),
    require('../../assets/cards/clubs-5.png'),
    require('../../assets/cards/clubs-6.png'),
    require('../../assets/cards/clubs-7.png'),
    require('../../assets/cards/clubs-8.png'),
    require('../../assets/cards/clubs-9.png'),
    require('../../assets/cards/clubs-10.png'),
    require('../../assets/cards/clubs-11.png'),
    require('../../assets/cards/clubs-12.png'),
    require('../../assets/cards/clubs-13.png'),
  ],
  diamonds: [
    require('../../assets/cards/diamonds-1.png'),
    require('../../assets/cards/diamonds-2.png'),
    require('../../assets/cards/diamonds-3.png'),
    require('../../assets/cards/diamonds-4.png'),
    require('../../assets/cards/diamonds-5.png'),
    require('../../assets/cards/diamonds-6.png'),
    require('../../assets/cards/diamonds-7.png'),
    require('../../assets/cards/diamonds-8.png'),
    require('../../assets/cards/diamonds-9.png'),
    require('../../assets/cards/diamonds-10.png'),
    require('../../assets/cards/diamonds-11.png'),
    require('../../assets/cards/diamonds-12.png'),
    require('../../assets/cards/diamonds-13.png'),
  ],
  hearts: [
    require('../../assets/cards/hearts-1.png'),
    require('../../assets/cards/hearts-2.png'),
    require('../../assets/cards/hearts-3.png'),
    require('../../assets/cards/hearts-4.png'),
    require('../../assets/cards/hearts-5.png'),
    require('../../assets/cards/hearts-6.png'),
    require('../../assets/cards/hearts-7.png'),
    require('../../assets/cards/hearts-8.png'),
    require('../../assets/cards/hearts-9.png'),
    require('../../assets/cards/hearts-10.png'),
    require('../../assets/cards/hearts-11.png'),
    require('../../assets/cards/hearts-12.png'),
    require('../../assets/cards/hearts-13.png'),
  ],
  spades: [
    require('../../assets/cards/spades-1.png'),
    require('../../assets/cards/spades-2.png'),
    require('../../assets/cards/spades-3.png'),
    require('../../assets/cards/spades-4.png'),
    require('../../assets/cards/spades-5.png'),
    require('../../assets/cards/spades-6.png'),
    require('../../assets/cards/spades-7.png'),
    require('../../assets/cards/spades-8.png'),
    require('../../assets/cards/spades-9.png'),
    require('../../assets/cards/spades-10.png'),
    require('../../assets/cards/spades-11.png'),
    require('../../assets/cards/spades-12.png'),
    require('../../assets/cards/spades-13.png'),
  ],
};

export function playingCardImage(card: SpeedCard): ImageSourcePropType {
  const image = CARD_IMAGES[card.suit][card.rank - 1];
  if (!image) throw new RangeError(`No playing-card image for ${card.suit} rank ${card.rank}`);
  return image;
}
