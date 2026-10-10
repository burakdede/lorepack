import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  fsyncDirectory,
  hashBytes,
  LoreError,
  mkdirOwnerOnly,
  type ObjectStore,
  objectKey,
  writeFileAtomic,
} from '@lorepack/core';

export interface FileObjectStoreDependencies {
  /** Injectable so a test can observe which directories were made durable. */
  readonly fsyncDirectory?: (path: string) => void;
}

/**
 * Content-addressed objects on the filesystem, two levels of fan-out so no directory
 * grows unmanageable. Objects are immutable: writing content that already exists is a
 * verified no-op, which is what makes an interrupted build cheap to resume.
 */
export class FileObjectStore implements ObjectStore {
  readonly #root: string;
  readonly #fsyncDirectory: (path: string) => void;

  constructor(root: string, dependencies: FileObjectStoreDependencies = {}) {
    this.#root = root;
    this.#fsyncDirectory = dependencies.fsyncDirectory ?? fsyncDirectory;
  }

  #pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new LoreError(
        'LORE_E_INVALID_ARGUMENT',
        'Object hashes must be 64 lowercase hexadecimal characters.',
        {
          remediation: 'Pass the sha256 object hash recorded by the build.',
          subject: hash,
        },
      );
    }
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
    const directory = dirname(path);
    const firstCreated = mkdirOwnerOnly(directory);
    writeFileAtomic(path, data, { ownerOnly: true });
    // `writeFileAtomic` makes the file's entry durable in its directory, but a directory
    // created here is itself only an entry in its parent. Without syncing each new one, a
    // power loss after the build record commits could lose the path to an object the
    // active build references (#572).
    if (firstCreated !== undefined) {
      for (let created = directory; ; created = dirname(created)) {
        this.#fsyncDirectory(dirname(created));
        if (created === firstCreated || dirname(created) === created) break;
      }
    }
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
