import { describe, expect, it } from 'vitest';

import { elementalCompletionDestination } from './elemental-completion';

describe('Ember and Tide level completion', () => {
  it('advances through the entire published order, including an inserted level', () => {
    expect(elementalCompletionDestination(1, 4)).toEqual({ type: 'advance', nextLevel: 2 });
    expect(elementalCompletionDestination(2, 4)).toEqual({ type: 'advance', nextLevel: 3 });
    expect(elementalCompletionDestination(3, 4)).toEqual({ type: 'advance', nextLevel: 4 });
  });

  it('ends a completed catalog only after its last level', () => {
    expect(elementalCompletionDestination(4, 4)).toEqual({ type: 'won' });
    expect(elementalCompletionDestination(1, 1)).toEqual({ type: 'won' });
    expect(elementalCompletionDestination(3, 4)).not.toEqual({ type: 'won' });
  });

  it('does not report a win for an unknown level number', () => {
    expect(elementalCompletionDestination(0, 4)).toEqual({ type: 'unavailable' });
    expect(elementalCompletionDestination(5, 4)).toEqual({ type: 'unavailable' });
  });
});
