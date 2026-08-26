/**
 * Desktop (Electron / web) shell entry point.
 *
 * The UI layer (windows, navigation, Electron safeStorage/OS keychain, desktop
 * notifications) is added in later tasks. This scaffold proves the shell
 * consumes the shared @ldr/core so that the desktop and mobile shells present
 * an identical themed experience (Requirement 5.1).
 */
import { CORE_PACKAGE_NAME, DEFAULT_COLOR_OPTION, getThemeTokens } from '@ldr/core';

export interface DesktopBootstrapInfo {
  platform: 'desktop';
  corePackage: string;
  activeColorOption: string;
  backgroundColor: string;
}

export function bootstrapDesktopShell(): DesktopBootstrapInfo {
  const tokens = getThemeTokens(DEFAULT_COLOR_OPTION);
  return {
    platform: 'desktop',
    corePackage: CORE_PACKAGE_NAME,
    activeColorOption: DEFAULT_COLOR_OPTION,
    backgroundColor: tokens.background,
  };
}
