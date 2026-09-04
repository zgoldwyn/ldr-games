import { createContext, useContext, type ReactNode } from 'react';

import type { AppRuntime, Identity } from './runtime';

export interface AppContextValue {
  readonly runtime: AppRuntime;
  readonly identity: Identity;
  readonly reload: () => Promise<void>;
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
