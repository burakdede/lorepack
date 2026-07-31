import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes, LoreError, type ObjectStore, objectKey } from '@lorepack/core';
import { writeFileAtomic } from './atomic.js';

/**
 * Content-addressed objects on the filesystem, two levels of fan-out so no directory
 * grows unmanageable. Objects are immutable: writing content that already exists is a
 * verified no-op, which is what makes an interrupted build cheap to resume.
 */
export class FileObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #pathFor(hash: string): string {
    return join(this.#root, ...objectKey(hash).split('/'));
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = hashBytes(data);
    const path = this.#pathFor(hash);
    if (existsSync(path)) {
      // Verify rather than trust: a corrupt object must not be silently reused.
      this.#readVerified(hash, path);
      return hash;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileAtomic(path, data);
    return hash;
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const path = this.#pathFor(hash);
    if (!existsSync(path)) return null;
    return this.#readVerified(hash, path);
  }

  async has(hash: string): Promise<boolean> {
    return existsSync(this.#pathFor(hash));
  }

  #readVerified(hash: string, path: string): Uint8Array {
    const data = new Uint8Array(readFileSync(path));
    const actual = hashBytes(data);
    if (actual !== hash) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Object ${hash} failed its checksum and was not used.`,
        {
          remediation:
            'Delete .lore/cache and rebuild. If this recurs on a sealed build, the build directory is damaged; roll back and rebuild.',
          subject: hash,
          details: { expected: hash, actual },
        },
      );
    }
    return data;
  }

  /** Removes a corrupt object so the next build regenerates it instead of failing again. */
  quarantine(hash: string): void {
    rmSync(this.#pathFor(hash), { force: true });
  }
}
