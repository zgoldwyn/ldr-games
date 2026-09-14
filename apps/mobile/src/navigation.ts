import type { LegalDocumentId } from './legal/legal-content';
import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  readonly GameList: undefined;
  readonly Leaderboard: undefined;
  readonly Settings: undefined;
};

export type RootStackParamList = {
  readonly SignIn: undefined;
  readonly Pairing: undefined;
  readonly MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  readonly GameList: undefined;
  readonly Leaderboard: undefined;
  readonly Settings: undefined;
  readonly Legal: undefined;
  readonly LegalDocument: { readonly document: LegalDocumentId };
  readonly TicTacToe: { readonly sessionId: string };
  readonly Battleship: { readonly sessionId: string };
};
