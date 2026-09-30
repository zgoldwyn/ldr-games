import { createContext, useContext, type ReactNode } from 'react';
import type {
  AccountDetails,
  ColorOptionName,
  RelationshipDate,
  ThemeTokens,
} from '@ldr/core';

import type { AppRuntime, Identity } from './runtime';
import type { PartnerAppPresence } from './app-presence';

export interface AppContextValue {
  readonly runtime: AppRuntime;
  readonly identity: Identity;
  readonly reload: () => Promise<void>;
  readonly accountDetails: AccountDetails | null;
  readonly partnerPresence: PartnerAppPresence;
  readonly importantDates: readonly RelationshipDate[];
  readonly refreshImportantDates: () => Promise<void>;
  readonly refreshAccount: () => Promise<void>;
  readonly tokens: ThemeTokens;
  readonly colorOption: ColorOptionName;
  readonly setColorOption: (option: ColorOptionName) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  value,
  children,
}: {
  readonly value: AppContextValue;
  readonly children: ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}
