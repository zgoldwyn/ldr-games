// `babel-preset-expo` covers JSX, TypeScript, and the React Native runtime
// transforms. Nothing app-specific is needed yet; screens (task 22.1b) add no
// Babel requirements of their own.
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
