import { ImageBackground, StyleSheet, View } from 'react-native';
import type { ThemeTokens } from '@ldr/core';

import clayGamePattern from '../../assets/navigation-clay-pattern.png';

export function IllustratedHeaderBackground({ tokens }: { readonly tokens: ThemeTokens }) {
  return (
    <ImageBackground
      source={clayGamePattern}
      resizeMode="cover"
      style={styles.background}
      imageStyle={styles.image}
      accessible={false}
    >
      <View style={[styles.tint, { backgroundColor: tokens.background }]} />
      <View style={styles.highlight} />
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1 },
  image: { opacity: 0.9 },
  tint: { position: 'absolute', inset: 0, opacity: 0.08 },
  highlight: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
});
