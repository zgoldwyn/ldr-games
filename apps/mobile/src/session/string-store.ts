/** Minimal key-value port so session helpers can be tested without Expo APIs. */
export interface StringStore {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}
