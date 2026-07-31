import { hashBytes, type ObjectStore } from '@lorepack/core';

/**
 * An in-memory ObjectStore for tests.
 *
 * The compiler depends on the port, not on an adapter, so testing against a fake is not a
 * shortcut: it is the same contract the real store satisfies, and it keeps the
 * architecture rule that forbids compiler importing backend-local honest.
 */
export class FakeObjectStore implements ObjectStore {
  readonly #objects = new Map<string, Uint8Array>();
  writes = 0;

  async put(data: Uint8Array): Promise<string> {
    const hash = hashBytes(data);
    if (!this.#objects.has(hash)) {
      this.#objects.set(hash, data);
      this.writes += 1;
    }
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.#objects.get(hash) ?? null;
  }

  async has(hash: string): Promise<boolean> {
    return this.#objects.has(hash);
  }

  get size(): number {
    return this.#objects.size;
  }

  text(hash: string): string {
    const bytes = this.#objects.get(hash);
    return bytes === undefined ? '' : new TextDecoder().decode(bytes);
  }
}
