export type BattleshipResultAction = 'hide' | 'reveal' | 'jump' | 'scroll';

/** Decide how a terminal result enters without racing the scroll position. */
export function battleshipResultAction({
  terminal,
  scrollY,
  reducedMotion,
}: {
  readonly terminal: boolean;
  readonly scrollY: number;
  readonly reducedMotion: boolean;
}): BattleshipResultAction {
  if (!terminal) return 'hide';
  if (scrollY <= 1) return 'reveal';
  return reducedMotion ? 'jump' : 'scroll';
}
