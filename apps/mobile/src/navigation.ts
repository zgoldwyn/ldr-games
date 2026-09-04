export type RootStackParamList = {
  readonly SignIn: undefined;
  readonly Pairing: undefined;
  readonly GameList: undefined;
  readonly TicTacToe: { readonly sessionId: string };
  readonly Battleship: { readonly sessionId: string };
};
