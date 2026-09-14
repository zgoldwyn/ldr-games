import type { MainTabParamList } from './navigation';

export type MainTabName = keyof MainTabParamList;

export const PRIMARY_TABS: readonly {
  readonly route: MainTabName;
  readonly label: string;
  readonly icon: string;
}[] = [
  { route: 'GameList', label: 'Play', icon: '▶︎' },
  { route: 'Leaderboard', label: 'Scores', icon: '★' },
  { route: 'Settings', label: 'Settings', icon: '⚙︎' },
];

export function primaryTab(route: MainTabName) {
  return PRIMARY_TABS.find((tab) => tab.route === route)!;
}
