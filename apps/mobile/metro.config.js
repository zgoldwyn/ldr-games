// Metro configuration for the npm-workspaces monorepo.
//
// Two things differ from a standalone Expo app, and both are required for
// `@ldr/core` to resolve:
//
//  1. `watchFolders` must include the repo root, because the shared package
//     lives outside this app's directory and Metro will not follow a symlink
//     out of `projectRoot` on its own.
//  2. `nodeModulesPaths` must list BOTH the app's own `node_modules` and the
//     hoisted root one. npm workspaces hoists most dependencies to the root, so
//     resolving only against the app directory finds almost nothing.
//
//  3. `disableHierarchicalLookup` stops Metro from walking up from a module's
//     own directory. Without it, a hoisted package under the root
//     `node_modules` finds the root copy of `react` while app code finds the
//     app's copy — two React instances in one bundle, which fails as "Invalid
//     hook call" the moment any hoisted component renders a hook. npm leaves
//     exactly that layout here: peer auto-install hoists a newer React and
//     React Native to the root while Expo pins the SDK-compatible pair under
//     the app. Resolving only through `nodeModulesPaths`, app-first, makes the
//     pinned copies the only ones that can be reached.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

// `@ldr/core` ships ESM with an `exports` map, which Metro only honours with
// package exports enabled.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
