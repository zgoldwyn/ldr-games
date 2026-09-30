import { describe, expect, it, vi } from 'vitest';

import { installHermesFinalizationRegistry } from './hermes-finalization-registry';

describe('Hermes FinalizationRegistry compatibility shim', () => {
  it('installs the minimal no-op surface only when the runtime lacks it', () => {
    const runtime: Record<string, unknown> = {};

    expect(installHermesFinalizationRegistry(runtime)).toBe(true);
    const Registry = runtime.FinalizationRegistry as new (
      cleanup: (heldValue: unknown) => void,
    ) => {
      register(target: object, heldValue: unknown, unregisterToken?: object): void;
      unregister(unregisterToken: object): boolean;
    };
    const cleanup = vi.fn();
    const registry = new Registry(cleanup);
    const token = {};

    expect(() => registry.register({}, { id: 1 }, token)).not.toThrow();
    expect(registry.unregister(token)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('preserves a native FinalizationRegistry implementation', () => {
    const NativeRegistry = class {};
    const runtime = { FinalizationRegistry: NativeRegistry };

    expect(installHermesFinalizationRegistry(runtime)).toBe(false);
    expect(runtime.FinalizationRegistry).toBe(NativeRegistry);
  });
});
