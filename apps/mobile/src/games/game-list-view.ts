export function unfinishedGames<T extends { readonly state: string }>(
  sessions: readonly T[],
): readonly T[] {
  return sessions.filter((session) => session.state !== 'terminal');
}

export function sessionStateLabel(state: string): string {
  switch (state) {
    case 'pending':
      return 'Waiting for partner';
    case 'active':
      return 'In progress';
    case 'paused':
      return 'Paused';
    default:
      return 'Game';
  }
}
