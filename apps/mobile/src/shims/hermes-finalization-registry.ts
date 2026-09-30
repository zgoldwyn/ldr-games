type FinalizationRegistryTarget = Record<string, unknown>;

/**
 * Hermes in the current Expo runtime does not expose FinalizationRegistry.
 * Colyseus Schema references it while loading its server-side StateView code,
 * even though the React Native client only decodes state and never constructs
 * a StateView. This no-op supplies the minimum standard surface needed at
 * module load. It intentionally does not emulate garbage-collection callbacks;
 * code that owns a StateView must still call its explicit dispose path.
 */
export function installHermesFinalizationRegistry(target: FinalizationRegistryTarget): boolean {
  if (typeof target.FinalizationRegistry !== 'undefined') return false;

  class NoopFinalizationRegistry {
    constructor(_cleanupCallback: (heldValue: unknown) => void) {}

    register(_target: object, _heldValue: unknown, _unregisterToken?: object): void {}

    unregister(_unregisterToken: object): boolean {
      return false;
    }
  }

  Object.defineProperty(target, 'FinalizationRegistry', {
    configurable: true,
    writable: true,
    value: NoopFinalizationRegistry,
  });
  return true;
}

installHermesFinalizationRegistry(globalThis as unknown as FinalizationRegistryTarget);
