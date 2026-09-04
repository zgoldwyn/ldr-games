/**
 * Expo entry point.
 *
 * `registerRootComponent` is Expo's `AppRegistry.registerComponent` wrapper: it
 * also sets up the dev-client and the correct root view on both platforms, which
 * is why this exists rather than calling AppRegistry directly.
 */
// NOTE: relative imports in this app are EXTENSIONLESS, unlike `@ldr/core`.
// Core is ESM consumed by Node and must spell out `.js`; this app is bundled by
// Metro, which resolves literally and would look for a real `App.js` next to a
// file that is actually `App.tsx`. TypeScript's `Bundler` module resolution
// accepts the extensionless form, so both tools agree.
import { registerRootComponent } from 'expo';

import { App } from './App';

registerRootComponent(App);
