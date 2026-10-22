import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  type FileHandle,
  mkdir as mkdirAsync,
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { diskFullError } from '../errors/disk-full.js';
import { LoreError } from '../errors/lore-error.js';

/**
 * Atomic filesystem primitives.
 *
 * These live in `core` rather than in a storage adapter because they are not about
 * storage: the CLI writes project files with them, the compiler writes reports, and the
 * build store writes databases. The pattern is always the same, and having two
 * implementations of "write without a reader seeing half of it" would be one too many.
 */

/**
 * Directory fsync is a POSIX guarantee. Windows has no equivalent and rejects the handle,
 * so the call is best effort there. Rename within a filesystem is atomic on both, and that
 * is the property the callers actually depend on.
 */
export function fsyncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Windows and some network filesystems refuse this. Not fatal.
  } finally {
    closeSync(fd);
  }
}

/** Sync a directory without occupying the JavaScript thread while storage flushes it. */
export async function fsyncDirectoryAsync(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle;
  try {
    handle = await openAsync(directory, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Some filesystems refuse directory sync. File and rename durability still apply.
  } finally {
    try {
      await handle.close();
    } catch {
      // Directory sync is best effort on filesystems that do not support it.
    }
  }
}

/**
 * Modes for everything under `.lore`, which holds a normalized copy of every source (#569).
 *
 * A source the owner made 0600 must not come back out world-readable as an object or a cache
 * entry, so new directories request 0700 and files 0600. A restrictive umask can remove
 * owner bits too. Node applies a mode
 * only when it creates the file or directory; nothing here changes an existing one. Windows
 * has no equivalent bits; `.lore` inherits its parent directory ACLs.
 */
export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

export interface WriteOptions {
  /** Create the file 0600 and any missing parent directories 0700. */
  readonly ownerOnly?: boolean;
}

export interface AsyncWriteOptions extends WriteOptions {
  /** Keep atomic replacement but skip flushes for reconstructible data such as caches. */
  readonly durability?: 'durable' | 'atomic-only';
}

/** Creates `directory` and any missing parents owner-only, returning the first one created. */
export function mkdirOwnerOnly(directory: string): string | undefined {
  return mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
}

/** Creates a private directory tree without blocking the JavaScript thread. */
export function mkdirOwnerOnlyAsync(directory: string): Promise<string | undefined> {
  return mkdirAsync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
}

let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return `${counter.toString(36)}${Math.trunc(performance.now() * 1000).toString(36)}`;
}

/** Writes a file so a reader never observes partial content. */
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): void {
  const directory = dirname(path);
  if (options.ownerOnly === true) mkdirOwnerOnly(directory);
  else mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.tmp-${process.pid}-${randomSuffix()}`);
  try {
    // The mode is set when the temporary file is created, so the content is never readable
    // by anyone else, even for the moment before the rename.
    writeFileSync(
      temporary,
      data,
      options.ownerOnly === true ? { mode: OWNER_ONLY_FILE_MODE, flag: 'wx' } : {},
    );
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } catch (cause) {
    rmSync(temporary, { force: true });
    const full = diskFullError(cause);
    if (full !== null) throw full;
    throw new LoreError('LORE_E_INTERNAL', `Could not write ${path}.`, {
      remediation: 'Check the directory exists and has free space.',
      cause,
    });
  }
}

/** Atomically replace a file while yielding during filesystem operations. */
export async function writeFileAtomicAsync(
  path: string,
  data: string | Uint8Array,
  options: AsyncWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  if (options.ownerOnly === true)
    await mkdirAsync(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  else await mkdirAsync(directory, { recursive: true });
  const temporary = join(directory, `.tmp-${process.pid}-${randomSuffix()}`);
  try {
    const handle = await openAsync(
      temporary,
      'wx',
      options.ownerOnly === true ? OWNER_ONLY_FILE_MODE : undefined,
    );
    try {
      await handle.writeFile(data);
      if (options.durability !== 'atomic-only') await handle.sync();
    } finally {
      await handle.close();
    }
    await renameAsync(temporary, path);
    if (options.durability !== 'atomic-only') await fsyncDirectoryAsync(directory);
  } catch (cause) {
    await rmAsync(temporary, { force: true });
    const full = diskFullError(cause);
    if (full !== null) throw full;
    throw new LoreError('LORE_E_INTERNAL', `Could not write ${path}.`, {
      remediation: 'Check the directory exists and has free space.',
      cause,
    });
  }
}
