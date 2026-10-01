import type { LegalDocumentId } from './legal/legal-content';
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { ElementalRole } from '@ldr/core';
import type { PlatformerSessionAccess } from './games/elemental-online';

export type MainTabParamList = {
  readonly Play: undefined;
  readonly AsyncGames: undefined;
  readonly Leaderboard: undefined;
  readonly ImportantDates: undefined;
  readonly Settings: undefined;
};

export type RootStackParamList = {
  readonly SignIn: undefined;
  readonly Pairing: undefined;
  readonly MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  readonly MiniGames: undefined;
  readonly CardGames: undefined;
  readonly WordGames: undefined;
  readonly Leaderboard: undefined;
  readonly Settings: undefined;
  readonly Account: undefined;
  readonly EditImportantDates: undefined;
  readonly Legal: undefined;
  readonly LegalDocument: { readonly document: LegalDocumentId };
  readonly TicTacToe: { readonly sessionId: string };
  readonly Battleship: { readonly sessionId: string };
  readonly DrawTogether: { readonly sessionId: string };
  readonly Speed: { readonly sessionId: string };
  readonly WordChain: { readonly sessionId: string };
  readonly QuizLibrary: undefined;
  readonly CouplesQuiz: { readonly sessionId: string };
  readonly ElementalDuetSetup: undefined;
  readonly ElementalDuet: {
    readonly role: ElementalRole;
    readonly access?: PlatformerSessionAccess;
  };
  readonly ElementalDuetWin: {
    readonly clearTicks: number;
    readonly levelCount: number;
  };
};
