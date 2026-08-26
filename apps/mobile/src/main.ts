/**
 * Mobile (Expo / React Native) shell entry point.
 *
 * The UI layer (screens, navigation, Expo SecureStore, Expo Push) is added in
 * later tasks. This scaffold proves the shell consumes the shared @ldr/core so
 * that the mobile and desktop shells present an identical themed experience
 * (Requirement 5.1).
 */
import { CORE_PACKAGE_NAME, DEFAULT_COLOR_OPTION, getThemeTokens } from '@ldr/core';

export interface MobileBootstrapInfo {
  platform: 'mobile';
  corePackage: string;
  activeColorOption: string;
  backgroundColor: string;
}

export function bootstrapMobileShell(): MobileBootstrapInfo {
  const tokens = getThemeTokens(DEFAULT_COLOR_OPTION);
  return {
    platform: 'mobile',
    corePackage: CORE_PACKAGE_NAME,
    activeColorOption: DEFAULT_COLOR_OPTION,
    backgroundColor: tokens.background,
  };
}
