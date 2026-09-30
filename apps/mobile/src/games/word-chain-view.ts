import {
  WORD_CHAIN_FIRST_WORD_MAX_LENGTH,
  WORD_CHAIN_GAME_ID,
  requiredWordChainLengths,
  requiredWordChainLetter,
  type AccountId,
  type WordChainState,
} from '@ldr/core';

export function asWordChainState(value: unknown): WordChainState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.game !== WORD_CHAIN_GAME_ID) return null;
  if (
    !Array.isArray(state.players) ||
    state.players.length !== 2 ||
    !isAccountId(state.players[0]) ||
    !isAccountId(state.players[1]) ||
    state.players[0] === state.players[1]
  ) {
    return null;
  }
  if (state.roles === null || typeof state.roles !== 'object' || Array.isArray(state.roles)) {
    return null;
  }
  const roles = state.roles as Record<string, unknown>;
  if (
    !isAccountId(roles.starter) ||
    !isAccountId(roles.partner) ||
    roles.starter === roles.partner ||
    !state.players.includes(roles.starter) ||
    !state.players.includes(roles.partner)
  ) {
    return null;
  }
  if (state.currentRole !== 'starter' && state.currentRole !== 'partner') return null;
  if (state.currentTurn !== roles[state.currentRole]) return null;
  if (state.status !== 'in_progress' && state.status !== 'won') return null;
  if (!Array.isArray(state.words)) return null;

  const used = new Set<string>();
  for (const [index, rawEntry] of state.words.entries()) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return null;
    const entry = rawEntry as Record<string, unknown>;
    const role = index % 2 === 0 ? 'starter' : 'partner';
    if (
      typeof entry.word !== 'string' ||
      !/^[a-z]+$/.test(entry.word) ||
      used.has(entry.word) ||
      entry.role !== role ||
      entry.player !== roles[role]
    ) {
      return null;
    }
    if (index === 0) {
      if (entry.word.length < 2 || entry.word.length > WORD_CHAIN_FIRST_WORD_MAX_LENGTH)
        return null;
    } else {
      const previous = state.words[index - 1] as { readonly word: string };
      const growth = entry.word.length - previous.word.length;
      if (entry.word[0] !== previous.word.at(-1) || (growth !== 1 && growth !== 2)) return null;
    }
    used.add(entry.word);
  }

  if (state.currentRole !== (state.words.length % 2 === 0 ? 'starter' : 'partner')) return null;
  if (state.status === 'in_progress') {
    if (state.winner !== null || state.loser !== null || state.endedBy !== null) return null;
  } else if (
    !isAccountId(state.winner) ||
    !isAccountId(state.loser) ||
    state.winner === state.loser ||
    !state.players.includes(state.winner) ||
    !state.players.includes(state.loser) ||
    state.loser !== state.currentTurn ||
    state.endedBy !== 'give_up'
  ) {
    return null;
  }
  return state as WordChainState;
}

function isAccountId(value: unknown): value is AccountId {
  return typeof value === 'string' && value.trim().length > 0;
}

export function wordChainPrompt(state: WordChainState): string {
  const required = requiredWordChainLetter(state);
  const [minimum, maximum] = requiredWordChainLengths(state);
  if (required === null) return `Play a ${minimum}–${maximum} letter word`;
  return `Start with ${required.toUpperCase()} · ${minimum} or ${maximum} letters`;
}

export function wordChainRole(
  state: WordChainState,
  self: AccountId | undefined,
): 'Starter' | 'Partner' | null {
  if (self === undefined) return null;
  if (state.roles.starter === self) return 'Starter';
  if (state.roles.partner === self) return 'Partner';
  return null;
}

export function wordChainSessionSummary(
  sessionState: string,
  state: WordChainState | null,
  self: AccountId | undefined,
): string {
  if (sessionState !== 'active' || state === null) {
    switch (sessionState) {
      case 'pending':
        return 'Waiting for partner';
      case 'paused':
        return 'Paused';
      default:
        return 'Game';
    }
  }
  if (state.currentTurn !== self) return "Partner's turn";
  return `Your turn · ${wordChainPrompt(state)}`;
}

export function wordChainStatus(params: {
  readonly sessionState: 'pending' | 'active' | 'paused' | 'terminal' | undefined;
  readonly state: WordChainState | null;
  readonly self: AccountId | undefined;
  readonly partnerName?: string;
}): { readonly title: string; readonly detail: string } {
  const { sessionState, state, self, partnerName } = params;
  const partner = partnerName?.trim() || 'your partner';
  if (!sessionState) return { title: 'Loading chain…', detail: 'Getting the latest words.' };
  if (sessionState === 'pending') {
    return { title: `Waiting for ${partner}`, detail: 'The duel starts when they join.' };
  }
  if (sessionState === 'paused') {
    return { title: 'Game paused', detail: 'Rejoin when you are both ready.' };
  }
  if (sessionState === 'terminal' || state?.status === 'won') {
    const won = state?.winner !== null && state?.winner === self;
    const loser = state?.loser === self ? 'You' : partnerName?.trim() || 'Your partner';
    const wordCount = state?.words.length ?? 0;
    return {
      title: won ? 'You win!' : 'Round over',
      detail: `${loser} gave up after ${wordCount} ${wordCount === 1 ? 'word' : 'words'}.`,
    };
  }
  if (state === null) return { title: 'Setting up…', detail: 'Building a fresh word chain.' };
  if (state.currentTurn === self) {
    return { title: 'Your turn', detail: wordChainPrompt(state) };
  }
  return {
    title: `${partnerName?.trim() || 'Partner'}’s turn`,
    detail: 'Think ahead—the next word must be longer.',
  };
}
