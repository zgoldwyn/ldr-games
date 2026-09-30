import { useEffect, useRef } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

type GameKey = 'left' | 'right' | 'jump' | 'interact';

type KeyboardInputEvent = {
  readonly key: GameKey;
  readonly pressed: boolean;
};

type GameKeyboardControls = {
  readonly onHorizontalChange: (value: -1 | 0 | 1) => void;
  readonly onJump: () => void;
  readonly onInteract?: () => void;
};

function webGameKey(key: string): GameKey | null {
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  if (key === 'ArrowUp' || key === ' ') return 'jump';
  if (key === 'ArrowDown' || key.toLowerCase() === 'e') return 'interact';
  return null;
}

export function useGameKeyboardControls(controls: GameKeyboardControls): void {
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  useEffect(() => {
    const held = new Set<GameKey>();

    const updateHorizontal = () => {
      controlsRef.current.onHorizontalChange(
        held.has('left') === held.has('right') ? 0 : held.has('left') ? -1 : 1,
      );
    };

    const handleInput = ({ key, pressed }: KeyboardInputEvent) => {
      const wasHeld = held.has(key);
      if (pressed) held.add(key);
      else held.delete(key);

      if (key === 'left' || key === 'right') {
        updateHorizontal();
      } else if (pressed && !wasHeld && key === 'jump') {
        controlsRef.current.onJump();
      } else if (pressed && !wasHeld && key === 'interact') {
        controlsRef.current.onInteract?.();
      }
    };

    const releaseAll = () => {
      held.clear();
      controlsRef.current.onHorizontalChange(0);
    };

    if (Platform.OS === 'web') {
      const onKeyDown = (event: KeyboardEvent) => {
        const key = webGameKey(event.key);
        if (!key) return;
        event.preventDefault();
        handleInput({ key, pressed: true });
      };
      const onKeyUp = (event: KeyboardEvent) => {
        const key = webGameKey(event.key);
        if (!key) return;
        event.preventDefault();
        handleInput({ key, pressed: false });
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', releaseAll);
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', releaseAll);
        releaseAll();
      };
    }

    const keyboardModule = NativeModules.KeyboardInputModule;
    if (!keyboardModule) return releaseAll;
    const subscription = new NativeEventEmitter(keyboardModule).addListener(
      'gameKeyboardInput',
      handleInput,
    );
    return () => {
      subscription.remove();
      releaseAll();
    };
  }, []);
}
