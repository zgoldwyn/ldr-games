import { StyleSheet, View } from 'react-native';
import type { ElementalRole, ThemeTokens } from '@ldr/core';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

type ClayElementalSpriteProps = {
  readonly role: ElementalRole;
  readonly tokens: ThemeTokens;
  readonly velocityX: SharedValue<number>;
  /** Negative while rising, positive while falling. */
  readonly velocityY: SharedValue<number>;
  readonly grounded: SharedValue<boolean>;
};

export function ClayElementalSpritePreview({
  role,
  tokens,
  size,
}: {
  readonly role: ElementalRole;
  readonly tokens: ThemeTokens;
  readonly size: number;
}) {
  const velocityX = useSharedValue(0);
  const velocityY = useSharedValue(0);
  const grounded = useSharedValue(true);
  return (
    <View style={{ width: size, height: size }}>
      <ClayElementalSprite
        role={role}
        tokens={tokens}
        velocityX={velocityX}
        velocityY={velocityY}
        grounded={grounded}
      />
    </View>
  );
}

/** A code-drawn clay game sprite. Every pose is derived on the UI thread. */
export function ClayElementalSprite({
  role,
  tokens,
  velocityX,
  velocityY,
  grounded,
}: ClayElementalSpriteProps) {
  const reducedMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const ember = role === 'ember';
  const bodyColor = ember ? '#F6A74D' : '#65BFE1';
  const bodyShade = ember ? '#D97832' : '#398CB8';
  const highlight = ember ? '#FFD9A0' : '#C9F1FF';

  useFrameCallback(({ timeSincePreviousFrame }) => {
    'worklet';
    if (timeSincePreviousFrame === null || reducedMotion) return;
    const speed = Math.min(Math.abs(velocityX.get()) / 90, 1);
    phase.set((current) => current + timeSincePreviousFrame * (speed > 0.08 ? 0.018 : 0.003));
  });

  const bodyMotion = useAnimatedStyle(() => {
    const vx = velocityX.get();
    const vy = velocityY.get();
    const onGround = grounded.get();
    const direction = vx < -0.5 ? -1 : 1;
    if (reducedMotion) return { transform: [{ scaleX: direction }] };
    if (!onGround) {
      const rising = vy < 0;
      return {
        transform: [
          { translateY: rising ? -2 : 1 },
          { rotate: `${direction * (rising ? -4 : 4)}deg` },
          { scaleX: direction * (rising ? 0.9 : 1.08) },
          { scaleY: rising ? 1.1 : 0.93 },
        ],
      };
    }
    const speed = Math.min(Math.abs(vx) / 90, 1);
    const bob = Math.sin(phase.get()) * 2.2 * speed + Math.sin(phase.get() * 0.22) * 0.45;
    return {
      transform: [
        { translateY: bob },
        { rotate: `${Math.sin(phase.get()) * 2.5 * speed}deg` },
        { scaleX: direction * (1 + Math.abs(bob) * 0.008) },
        { scaleY: 1 - Math.abs(bob) * 0.012 },
      ],
    };
  });

  const leftFootMotion = useAnimatedStyle(() => {
    const running = grounded.get() && Math.abs(velocityX.get()) > 4 && !reducedMotion;
    return { transform: [{ translateY: running ? Math.sin(phase.get()) * 3 : 0 }] };
  });
  const rightFootMotion = useAnimatedStyle(() => {
    const running = grounded.get() && Math.abs(velocityX.get()) > 4 && !reducedMotion;
    return { transform: [{ translateY: running ? -Math.sin(phase.get()) * 3 : 0 }] };
  });

  return (
    <View accessibilityElementsHidden style={styles.root}>
      <View style={[styles.groundShadow, { backgroundColor: tokens.textPrimary }]} />
      <Animated.View style={[styles.sprite, bodyMotion]}>
        <Animated.View
          style={[styles.foot, styles.leftFoot, { backgroundColor: bodyShade }, leftFootMotion]}
        />
        <Animated.View
          style={[styles.foot, styles.rightFoot, { backgroundColor: bodyShade }, rightFootMotion]}
        />
        <View
          style={[
            styles.body,
            {
              backgroundColor: bodyColor,
              boxShadow: [
                {
                  offsetX: 3,
                  offsetY: 5,
                  blurRadius: 7,
                  color: ember ? 'rgba(156, 68, 25, 0.34)' : 'rgba(24, 91, 132, 0.34)',
                },
                {
                  inset: true,
                  offsetX: -3,
                  offsetY: -4,
                  blurRadius: 6,
                  color: ember ? 'rgba(157, 68, 26, 0.28)' : 'rgba(26, 91, 132, 0.28)',
                },
                {
                  inset: true,
                  offsetX: 3,
                  offsetY: 3,
                  blurRadius: 5,
                  color: 'rgba(255,255,255,0.55)',
                },
              ],
            },
          ]}
        >
          <View style={[styles.cheek, { backgroundColor: highlight }]} />
          <View style={styles.face}>
            <View style={[styles.eye, { backgroundColor: tokens.textPrimary }]} />
            <View style={[styles.eye, { backgroundColor: tokens.textPrimary }]} />
          </View>
          <View style={[styles.mouth, { backgroundColor: bodyShade }]} />
        </View>
        {ember ? (
          <View style={styles.emberCrown}>
            <View style={[styles.flame, styles.flameLeft, { backgroundColor: bodyShade }]} />
            <View style={[styles.flame, styles.flameCenter, { backgroundColor: bodyColor }]} />
            <View style={[styles.flame, styles.flameRight, { backgroundColor: '#FFD064' }]} />
          </View>
        ) : (
          <View style={styles.tideCrown}>
            <View style={[styles.wave, styles.waveBack, { backgroundColor: bodyShade }]} />
            <View style={[styles.wave, { backgroundColor: bodyColor }]} />
            <View style={[styles.waveShine, { backgroundColor: highlight }]} />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', height: '100%', overflow: 'visible' },
  groundShadow: {
    position: 'absolute',
    width: '76%',
    height: '18%',
    left: '12%',
    bottom: '-5%',
    borderRadius: 999,
    opacity: 0.15,
    transform: [{ scaleY: 0.55 }],
  },
  sprite: { width: '100%', height: '100%', transformOrigin: 'center bottom' },
  body: {
    position: 'absolute',
    left: '8%',
    bottom: '9%',
    width: '84%',
    height: '74%',
    borderRadius: 999,
    alignItems: 'center',
  },
  cheek: {
    position: 'absolute',
    width: '62%',
    height: '30%',
    left: '12%',
    top: '9%',
    borderRadius: 999,
    opacity: 0.48,
    transform: [{ rotate: '-12deg' }],
  },
  face: {
    position: 'absolute',
    top: '38%',
    left: '25%',
    width: '50%',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eye: { width: 4, height: 6, borderRadius: 999 },
  mouth: {
    position: 'absolute',
    width: '20%',
    height: 3,
    borderRadius: 999,
    bottom: '22%',
    opacity: 0.72,
  },
  foot: {
    position: 'absolute',
    width: '31%',
    height: '19%',
    bottom: 0,
    borderRadius: 999,
  },
  leftFoot: { left: '12%', transform: [{ rotate: '8deg' }] },
  rightFoot: { right: '12%', transform: [{ rotate: '-8deg' }] },
  emberCrown: { position: 'absolute', left: '18%', top: '-19%', width: '64%', height: '36%' },
  flame: { position: 'absolute', bottom: 0, borderRadius: 999, transform: [{ rotate: '35deg' }] },
  flameLeft: { left: '4%', width: '34%', height: '66%' },
  flameCenter: { left: '31%', width: '38%', height: '100%' },
  flameRight: { right: '2%', width: '32%', height: '72%' },
  tideCrown: { position: 'absolute', left: '10%', top: '-11%', width: '80%', height: '29%' },
  wave: {
    position: 'absolute',
    left: '5%',
    bottom: 0,
    width: '70%',
    height: '76%',
    borderRadius: 999,
  },
  waveBack: { left: '28%', bottom: '22%', width: '66%', height: '66%', opacity: 0.8 },
  waveShine: {
    position: 'absolute',
    left: '24%',
    top: '10%',
    width: '28%',
    height: '22%',
    borderRadius: 999,
    opacity: 0.72,
  },
});
