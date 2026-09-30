import { describe, expect, it } from 'vitest';

import { accountId } from './common.js';
import {
  createWordChainLexicon,
  createWordChainState,
  giveUpWordChain,
  normalizeWordChainWord,
  requiredWordChainLengths,
  requiredWordChainLetter,
  submitWordChainWord,
  WORD_CHAIN_LEXICON,
  wordChainRoleForPlayer,
  wordChainRuleset,
} from './word-chain.js';

const STARTER = accountId('starter');
const PARTNER = accountId('partner');
const OUTSIDER = accountId('outsider');
const LEXICON = createWordChainLexicon([
  'at',
  'cat',
  'apple',
  'tiger',
  'rabbit',
  'tornado',
  'orchards',
  'cafe',
]);

function accepted(result: ReturnType<typeof submitWordChainWord>) {
  if (!result.accepted) throw new Error(`Expected acceptance, got ${result.reason}`);
  return result.state;
}

describe('Word Chain normalization and lexicon', () => {
  it('normalizes case, surrounding whitespace, and Latin diacritics', () => {
    expect(normalizeWordChainWord('  CAF\u00c9  ')).toBe('cafe');
    expect(LEXICON.has('cafe')).toBe(true);
  });

  it('ships a broad English lexicon with common words', () => {
    for (const word of ['cat', 'tiger', 'rabbit', 'tornado', 'competition']) {
      expect(WORD_CHAIN_LEXICON.has(word), word).toBe(true);
    }
  });

  it('rejects blank, non-alphabetic, and unknown submissions distinctly', () => {
    const state = createWordChainState(STARTER, PARTNER);
    expect(submitWordChainWord(state, STARTER, '   ', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'empty_word',
    });
    expect(submitWordChainWord(state, STARTER, 'two words', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'invalid_characters',
    });
    expect(submitWordChainWord(state, STARTER, 'zzzzz', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'not_in_lexicon',
    });
  });
});

describe('competitive Word Chain state transitions', () => {
  it('accepts a 2–5 letter opener and alternates turns', () => {
    const initial = createWordChainState(STARTER, PARTNER);
    expect(initial.roles).toEqual({ starter: STARTER, partner: PARTNER });
    expect(wordChainRoleForPlayer(initial, STARTER)).toBe('starter');
    expect(requiredWordChainLengths(initial)).toEqual([2, 5]);

    const afterCat = accepted(submitWordChainWord(initial, STARTER, ' Cat ', LEXICON));
    expect(afterCat.currentRole).toBe('partner');
    expect(afterCat.currentTurn).toBe(PARTNER);
    expect(afterCat.words[0]).toEqual({ word: 'cat', player: STARTER, role: 'starter' });
    expect(requiredWordChainLetter(afterCat)).toBe('t');
    expect(requiredWordChainLengths(afterCat)).toEqual([4, 5]);
  });

  it('requires each chained word to be exactly one or two letters longer', () => {
    const afterCat = accepted(
      submitWordChainWord(createWordChainState(STARTER, PARTNER), STARTER, 'cat', LEXICON),
    );
    expect(submitWordChainWord(afterCat, PARTNER, 'at', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'invalid_length',
    });
    expect(submitWordChainWord(afterCat, PARTNER, 'tornado', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'invalid_length',
    });

    const afterTiger = accepted(submitWordChainWord(afterCat, PARTNER, 'tiger', LEXICON));
    expect(requiredWordChainLengths(afterTiger)).toEqual([6, 7]);
    const afterRabbit = accepted(submitWordChainWord(afterTiger, STARTER, 'rabbit', LEXICON));
    expect(afterRabbit.words).toHaveLength(3);
  });

  it('enforces the chain letter and prevents normalized repeats', () => {
    const afterApple = accepted(
      submitWordChainWord(createWordChainState(STARTER, PARTNER), STARTER, 'apple', LEXICON),
    );
    expect(submitWordChainWord(afterApple, PARTNER, 'rabbit', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'wrong_starting_letter',
    });

    const repeatedState = {
      ...afterApple,
      currentTurn: STARTER,
      currentRole: 'starter' as const,
    };
    expect(submitWordChainWord(repeatedState, STARTER, ' APPLE ', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'already_used',
    });
  });

  it('lets only the active player give up and awards the win to their opponent', () => {
    const afterCat = accepted(
      submitWordChainWord(createWordChainState(STARTER, PARTNER), STARTER, 'cat', LEXICON),
    );
    expect(giveUpWordChain(afterCat, STARTER)).toMatchObject({ ok: false });
    expect(giveUpWordChain(afterCat, OUTSIDER)).toMatchObject({ ok: false });

    const result = giveUpWordChain(afterCat, PARTNER);
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'won', winner: STARTER, loser: PARTNER, endedBy: 'give_up' },
    });
    if (!result.ok) return;
    expect(wordChainRuleset.outcome(result.value, 123)).toEqual({
      kind: 'completed',
      winner: STARTER,
      recordedAt: 123,
    });
  });

  it('registers submit and give-up moves with the live ruleset', () => {
    const initial = wordChainRuleset.createInitialState([STARTER, PARTNER], STARTER);
    const played = wordChainRuleset.applyMove(initial, STARTER, {
      type: 'submit_word',
      word: 'cat',
    });
    expect(played).toMatchObject({ ok: true, value: { currentTurn: PARTNER } });
    if (!played.ok) return;
    expect(wordChainRuleset.applyMove(played.value, PARTNER, { type: 'give_up' })).toMatchObject({
      ok: true,
      value: { winner: STARTER },
    });
  });

  it('rejects outsiders, out-of-turn players, and moves after completion', () => {
    const state = createWordChainState(STARTER, PARTNER);
    expect(submitWordChainWord(state, OUTSIDER, 'cat', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'not_participant',
    });
    expect(submitWordChainWord(state, PARTNER, 'cat', LEXICON)).toMatchObject({
      accepted: false,
      reason: 'not_your_turn',
    });
    const finished = giveUpWordChain(state, STARTER);
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(submitWordChainWord(finished.value, PARTNER, 'cat', LEXICON)).toMatchObject({
        accepted: false,
        reason: 'round_complete',
      });
    }
  });

  it('validates round construction', () => {
    expect(() => createWordChainState(STARTER, STARTER)).toThrow(/different players/);
  });
});
