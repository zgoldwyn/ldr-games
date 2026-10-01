export type ElementalCompletionDestination =
  | { readonly type: 'advance'; readonly nextLevel: number }
  | { readonly type: 'won' }
  | { readonly type: 'unavailable' };

export function elementalCompletionDestination(
  currentLevel: number,
  authoredLevelCount: number,
): ElementalCompletionDestination {
  if (
    !Number.isInteger(currentLevel) ||
    !Number.isInteger(authoredLevelCount) ||
    currentLevel < 1 ||
    currentLevel > authoredLevelCount
  ) {
    return { type: 'unavailable' };
  }
  return currentLevel === authoredLevelCount
    ? { type: 'won' }
    : { type: 'advance', nextLevel: currentLevel + 1 };
}
