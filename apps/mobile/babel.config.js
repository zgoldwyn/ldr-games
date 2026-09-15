// `babel-preset-expo` covers JSX, TypeScript, and the React Native runtime
// transforms. Worklets must run last so Reanimated callbacks receive the
// `__initData` metadata expected by the native runtime.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
