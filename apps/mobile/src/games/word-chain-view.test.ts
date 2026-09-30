import { describe, expect, it } from 'vitest';
import {
  accountId,
  createWordChainLexicon,
  createWordChainState,
  giveUpWordChain,
  submitWordChainWord,
} from '@ldr/core';

import {
  asWordChainState,
  wordChainPrompt,
  wordChainRole,
  wordChainSessionSummary,
  wordChainStatus,
} from './word-chain-view';

const A = accountId('alice');
const B = accountId('bob');
const LEXICON = createWordChainLexicon(['cat', 'tiger', 'rabbit']);

function play(state = createWordChainState(A, B), player = A, word = 'cat') {
  const result = submitWordChainWord(state, player, word, LEXICON);
  if (!result.accepted) throw new Error(result.message);
  return result.state;
}

describe('competitive Word Chain presentation', () => {
  it('recognizes valid states and preserves fixed roles', () => {
    const state = createWordChainState(A, B);
    expect(asWordChainState(state)).toBe(state);
    expect(asWordChainState({ game: 'speed' })).toBeNull();
    expect(asWordChainState(null)).toBeNull();
    expect(asWordChainState([])).toBeNull();
    expect(wordChainRole(state, A)).toBe('Starter');
    expect(wordChainRole(state, B)).toBe('Partner');
    expect(wordChainRole(state, accountId('outside'))).toBeNull();
  });

  it('rejects malformed players, roles, turns, and result fields', () => {
    const state = createWordChainState(A, B);
    const invalid = [
      { players: [A] },
      { players: [A, A] },
      { roles: null },
      { roles: { starter: A, partner: A } },
      { currentTurn: accountId('outside') },
      { currentRole: 'spectator' },
      { status: 'draw' },
      { winner: A },
      { loser: B },
      { endedBy: 'timeout' },
      { words: {} },
    ];
    for (const mutation of invalid) {
      expect(asWordChainState({ ...state, ...mutation }), JSON.stringify(mutation)).toBeNull();
    }
  });

  it('rejects malformed words and inconsistent chain growth', () => {
    const one = play();
    const entry = one.words[0];
    for (const invalidEntry of [
      null,
      [],
      {},
      { ...entry, word: 'Cat' },
      { ...entry, word: 'a' },
      { ...entry, role: 'partner' },
      { ...entry, player: B },
    ]) {
      expect(asWordChainState({ ...one, words: [invalidEntry] })).toBeNull();
    }

    const two = play(one, B, 'tiger');
    expect(asWordChainState(two)).toBe(two);
    expect(
      asWordChainState({ ...two, words: [two.words[0], { ...two.words[1], word: 'rabbit' }] }),
    ).toBeNull();
  });

  it('recognizes a give-up result with the active player as loser', () => {
    const one = play();
    const result = giveUpWordChain(one, B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asWordChainState(result.value)).toBe(result.value);
    expect(asWordChainState({ ...result.value, winner: B, loser: A })).toBeNull();
  });

  it('describes opening and chained length requirements', () => {
    const state = createWordChainState(A, B);
    expect(wordChainPrompt(state)).toBe('Play a 2–5 letter word');
    expect(wordChainPrompt(play(state))).toBe('Start with T · 4 or 5 letters');
  });

  it('summarizes open games with actionable turn details', () => {
    const state = createWordChainState(A, B);
    expect(wordChainSessionSummary('pending', null, A)).toBe('Waiting for partner');
    expect(wordChainSessionSummary('paused', state, A)).toBe('Paused');
    expect(wordChainSessionSummary('active', state, A)).toBe('Your turn · Play a 2–5 letter word');
    expect(wordChainSessionSummary('active', state, B)).toBe("Partner's turn");
  });

  it('describes loading, waiting, active turns, and both result perspectives', () => {
    const state = createWordChainState(A, B);
    expect(wordChainStatus({ sessionState: undefined, state: null, self: A })).toEqual({
      title: 'Loading chain…',
      detail: 'Getting the latest words.',
    });
    expect(
      wordChainStatus({ sessionState: 'pending', state: null, self: A, partnerName: ' Sam ' }),
    ).toEqual({ title: 'Waiting for Sam', detail: 'The duel starts when they join.' });
    expect(wordChainStatus({ sessionState: 'active', state, self: A })).toEqual({
      title: 'Your turn',
      detail: 'Play a 2–5 letter word',
    });
    expect(wordChainStatus({ sessionState: 'active', state, self: B, partnerName: 'Sam' })).toEqual(
      {
        title: 'Sam’s turn',
        detail: 'Think ahead—the next word must be longer.',
      },
    );

    const one = play(state);
    const result = giveUpWordChain(one, B);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      wordChainStatus({
        sessionState: 'terminal',
        state: result.value,
        self: A,
        partnerName: 'Sam',
      }),
    ).toEqual({
      title: 'You win!',
      detail: 'Sam gave up after 1 word.',
    });
    expect(
      wordChainStatus({
        sessionState: 'terminal',
        state: result.value,
        self: B,
        partnerName: 'Sam',
      }),
    ).toEqual({
      title: 'Round over',
      detail: 'You gave up after 1 word.',
    });
  });
});
