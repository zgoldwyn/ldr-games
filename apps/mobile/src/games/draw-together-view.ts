import type { AccountId, DrawTogetherAttempt, DrawTogetherState } from '@ldr/core';

export function drawTogetherClockLabel(milliseconds: number): string {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function drawTogetherPhaseCopy(
  state: DrawTogetherState,
  self: AccountId | undefined,
  partnerName?: string,
): string {
  const partner = partnerName?.trim() || 'your partner';
  if (state.phase === 'waiting') return `Choose a match length when ${partner} joins.`;
  if (state.phase === 'choosing') {
    return state.drawer === self
      ? 'Choose a word to draw.'
      : partnerName?.trim()
        ? `${partnerName.trim()} is choosing a word…`
        : 'Partner choosing a word…';
  }
  if (state.phase === 'drawing') {
    return state.drawer === self ? `Draw it clearly—${partner} is guessing.` : 'Guess the drawing!';
  }
  return state.phase === 'finished' ? 'Time’s up!' : 'Get ready for the next word.';
}

export function drawTogetherMissedAttempts(
  state: DrawTogetherState,
): readonly DrawTogetherAttempt[] {
  return state.attempts.filter((attempt) => attempt.result === 'missed');
}

export function drawTogetherResultTitle(
  state: DrawTogetherState,
  bestScore: number | null,
): string {
  return bestScore !== null && state.score >= bestScore ? 'New best score!' : 'Nice work!';
}
