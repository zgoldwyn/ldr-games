import { err, ok, type Result } from '../result.js';
import type { MoveError } from '../errors.js';
import type { AccountId } from './common.js';
import type { Timestamp } from './common.js';
import type { GameOutcome, Move } from './game.js';
import { WORD_CHAIN_WORDS_TEXT } from './word-chain-words.js';
import {
  invalidMove,
  registerRuleset,
  type RealTimeRuleset,
  type RTGameStateBase,
} from './rt-engine.js';

export const WORD_CHAIN_GAME_ID = 'word-chain';
export const WORD_CHAIN_FIRST_WORD_MAX_LENGTH = 5;

export type WordChainRole = 'starter' | 'partner';
export type WordChainStatus = 'in_progress' | 'won';

export interface WordChainRoleAssignment {
  readonly starter: AccountId;
  readonly partner: AccountId;
}

export interface WordChainEntry {
  readonly word: string;
  readonly player: AccountId;
  readonly role: WordChainRole;
}

export interface WordChainState extends RTGameStateBase {
  readonly game: typeof WORD_CHAIN_GAME_ID;
  readonly players: readonly [AccountId, AccountId];
  readonly currentTurn: AccountId;
  readonly status: WordChainStatus;
  readonly winner: AccountId | null;
  readonly loser: AccountId | null;
  readonly endedBy: 'give_up' | null;
  /** Roles are assigned once at round creation and never change. */
  readonly roles: WordChainRoleAssignment;
  readonly currentRole: WordChainRole;
  readonly words: readonly WordChainEntry[];
}

export type WordChainMove = Move &
  ({ readonly type: 'submit_word'; readonly word: string } | { readonly type: 'give_up' });

export interface WordChainLexicon {
  has(word: string): boolean;
}

export type WordChainRejectionReason =
  | 'round_complete'
  | 'not_participant'
  | 'not_your_turn'
  | 'empty_word'
  | 'invalid_characters'
  | 'not_in_lexicon'
  | 'wrong_starting_letter'
  | 'invalid_length'
  | 'already_used';

export type WordChainSubmission =
  | {
      readonly accepted: true;
      readonly state: WordChainState;
      readonly entry: WordChainEntry;
    }
  | {
      readonly accepted: false;
      readonly state: WordChainState;
      readonly reason: WordChainRejectionReason;
      readonly message: string;
    };

const VALID_WORD = /^[a-z]+$/;

/**
 * Canonical form used for both submissions and curated lexicon entries.
 * Surrounding whitespace, case, and Latin diacritics do not affect a word.
 */
export function normalizeWordChainWord(rawWord: string): string {
  return rawWord
    .trim()
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Build an immutable, normalized lexicon from a curated collection. */
export function createWordChainLexicon(words: Iterable<string>): WordChainLexicon {
  const entries = new Set<string>();
  for (const rawWord of words) {
    const word = normalizeWordChainWord(rawWord);
    if (VALID_WORD.test(word)) entries.add(word);
  }
  return { has: (word) => entries.has(word) };
}

export function createWordChainState(starter: AccountId, partner: AccountId): WordChainState {
  if (starter === partner) throw new Error('Word Chain requires two different players');

  return {
    game: WORD_CHAIN_GAME_ID,
    players: [starter, partner],
    currentTurn: starter,
    status: 'in_progress',
    winner: null,
    loser: null,
    endedBy: null,
    roles: { starter, partner },
    currentRole: 'starter',
    words: [],
  };
}

export function wordChainPlayerForRole(state: WordChainState, role: WordChainRole): AccountId {
  return state.roles[role];
}

export function wordChainRoleForPlayer(
  state: WordChainState,
  player: AccountId,
): WordChainRole | null {
  if (state.roles.starter === player) return 'starter';
  if (state.roles.partner === player) return 'partner';
  return null;
}

export function requiredWordChainLetter(state: WordChainState): string | null {
  return state.words.at(-1)?.word.at(-1) ?? null;
}

export function requiredWordChainLengths(
  state: WordChainState,
): readonly [minimum: number, maximum: number] {
  const previousLength = state.words.at(-1)?.word.length;
  return previousLength === undefined
    ? [2, WORD_CHAIN_FIRST_WORD_MAX_LENGTH]
    : [previousLength + 1, previousLength + 2];
}

function reject(
  state: WordChainState,
  reason: WordChainRejectionReason,
  message: string,
): WordChainSubmission {
  return { accepted: false, state, reason, message };
}

/**
 * Apply one submission without mutating the previous state. Validation order is
 * stable so clients and an authoritative server return the same rejection.
 */
export function submitWordChainWord(
  state: WordChainState,
  player: AccountId,
  rawWord: string,
  lexicon: WordChainLexicon,
): WordChainSubmission {
  if (state.status === 'won') {
    return reject(state, 'round_complete', 'This round is already complete.');
  }

  const role = wordChainRoleForPlayer(state, player);
  if (role === null) {
    return reject(state, 'not_participant', 'Only players in this round can submit words.');
  }
  if (role !== state.currentRole) {
    return reject(state, 'not_your_turn', 'Wait for your partner to play.');
  }

  const word = normalizeWordChainWord(rawWord);
  if (word.length === 0) return reject(state, 'empty_word', 'Enter a word.');
  if (!VALID_WORD.test(word)) {
    return reject(state, 'invalid_characters', 'Use letters only.');
  }
  if (!lexicon.has(word)) {
    return reject(state, 'not_in_lexicon', "That word is not in this game's word list.");
  }

  if (state.words.some((entry) => entry.word === word)) {
    return reject(state, 'already_used', 'That word has already been used.');
  }

  const [minimumLength, maximumLength] = requiredWordChainLengths(state);
  if (word.length < minimumLength || word.length > maximumLength) {
    return reject(
      state,
      'invalid_length',
      state.words.length === 0
        ? `The first word must be ${minimumLength} to ${maximumLength} letters.`
        : `Your word must be ${minimumLength} or ${maximumLength} letters.`,
    );
  }

  const requiredLetter = requiredWordChainLetter(state);
  if (requiredLetter !== null && word[0] !== requiredLetter) {
    return reject(
      state,
      'wrong_starting_letter',
      `Your word must start with ${requiredLetter.toUpperCase()}.`,
    );
  }

  const entry: WordChainEntry = {
    word,
    player,
    role,
  };
  const words = [...state.words, entry];
  const nextState: WordChainState = {
    ...state,
    words,
    currentRole: role === 'starter' ? 'partner' : 'starter',
    currentTurn: role === 'starter' ? state.roles.partner : state.roles.starter,
  };

  return { accepted: true, state: nextState, entry };
}

export function giveUpWordChain(
  state: WordChainState,
  player: AccountId,
): Result<WordChainState, MoveError> {
  if (state.status === 'won') return err(invalidMove('This round is already complete.'));
  const role = wordChainRoleForPlayer(state, player);
  if (role === null) return err(invalidMove('Only players in this round can give up.'));
  if (state.currentTurn !== player) return err(invalidMove('Only the active player can give up.'));

  const winner = state.players.find((candidate) => candidate !== player);
  if (winner === undefined) return err(invalidMove('The winning player could not be resolved.'));
  return ok({
    ...state,
    status: 'won',
    winner,
    loser: player,
    endedBy: 'give_up',
  });
}

export const WORD_CHAIN_LEXICON = createWordChainLexicon(WORD_CHAIN_WORDS_TEXT.split('\n'));

function isWordChainMove(move: unknown): move is WordChainMove {
  if (move === null || typeof move !== 'object') return false;
  const value = move as { readonly type?: unknown; readonly word?: unknown };
  return (
    value.type === 'give_up' || (value.type === 'submit_word' && typeof value.word === 'string')
  );
}

export const wordChainRuleset: RealTimeRuleset<WordChainState, WordChainMove> = {
  game: WORD_CHAIN_GAME_ID,
  name: 'Word Chain',

  createInitialState(players, first): WordChainState {
    const partner = players.find((player) => player !== first);
    if (!partner) throw new Error('Word Chain first player must belong to the two-player roster');
    return createWordChainState(first, partner);
  },

  applyMove(state, actor, move): Result<WordChainState, MoveError> {
    if (!isWordChainMove(move)) return err(invalidMove('Unrecognized Word Chain move.'));
    if (move.type === 'give_up') return giveUpWordChain(state, actor);
    const result = submitWordChainWord(state, actor, move.word, WORD_CHAIN_LEXICON);
    return result.accepted ? ok(result.state) : err(invalidMove(result.message));
  },

  isTerminal(state): boolean {
    return state.status !== 'in_progress';
  },

  outcome(state, recordedAt: Timestamp): GameOutcome | null {
    if (state.status === 'in_progress') return null;
    return { kind: 'completed', winner: state.winner, recordedAt };
  },
};

registerRuleset(wordChainRuleset);
