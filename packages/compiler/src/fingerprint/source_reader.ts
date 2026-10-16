import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  read,
  readSync,
  realpathSync,
} from 'node:fs';
import { isInsideRoot } from '@lorepack/core';

export interface SourceReadBoundary {
  readonly path: string;
  readonly root: string;
  readonly projectRoot: string;
  readonly device: string;
  readonly inode: string;
  readonly maximumBytes: number;
}

export class SourceReadIssue extends Error {
  constructor(
    readonly code: 'source-changed' | 'artifact-too-large' | 'special-file',
    displayPath: string,
  ) {
    super(
      code === 'source-changed'
        ? `${displayPath} changed while its source was being read and was not indexed.`
        : code === 'artifact-too-large'
          ? `${displayPath} exceeds its configured artifact size limit and was not indexed.`
          : `${displayPath} is not a regular file and was not indexed.`,
    );
    this.name = 'SourceReadIssue';
  }
}

function inside(root: string, path: string): boolean {
  return root === path || isInsideRoot(root, path);
}

function regular(stats: BigIntStats, displayPath: string): void {
  if (stats.isSymbolicLink()) throw new SourceReadIssue('source-changed', displayPath);
  if (!stats.isFile()) throw new SourceReadIssue('special-file', displayPath);
}

function size(stats: BigIntStats, maximumBytes: number, displayPath: string): number {
  if (stats.size > BigInt(maximumBytes)) {
    throw new SourceReadIssue('artifact-too-large', displayPath);
  }
  return Number(stats.size);
}

export function captureSourceRead(
  path: string,
  options: {
    readonly root: string;
    readonly projectRoot: string;
    readonly maximumBytes: number;
    readonly allowLink: boolean;
    readonly displayPath: string;
  },
): { readonly sourceRead: SourceReadBoundary; readonly byteSize: number } {
  const entry = lstatSync(path, { bigint: true });
  if (!options.allowLink) regular(entry, options.displayPath);
  const physical = realpathSync(path);
  if (!inside(options.root, physical) || !inside(options.projectRoot, physical)) {
    throw new SourceReadIssue('source-changed', options.displayPath);
  }
  const stats = entry.isSymbolicLink() ? lstatSync(physical, { bigint: true }) : entry;
  regular(stats, options.displayPath);
  const byteSize = Number(stats.size);
  return {
    sourceRead: {
      path: physical,
      root: options.root,
      projectRoot: options.projectRoot,
      device: String(stats.dev),
      inode: String(stats.ino),
      maximumBytes: options.maximumBytes,
    },
    byteSize,
  };
}

function identity(stats: BigIntStats, boundary: SourceReadBoundary, displayPath: string): void {
  regular(stats, displayPath);
  if (String(stats.dev) !== boundary.device || String(stats.ino) !== boundary.inode) {
    throw new SourceReadIssue('source-changed', displayPath);
  }
  size(stats, boundary.maximumBytes, displayPath);
}

export function openSourceRead(boundary: SourceReadBoundary, displayPath: string): number {
  identity(lstatSync(boundary.path, { bigint: true }), boundary, displayPath);
  const physical = realpathSync(boundary.path);
  if (!inside(boundary.root, physical) || !inside(boundary.projectRoot, physical)) {
    throw new SourceReadIssue('source-changed', displayPath);
  }
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = openSync(boundary.path, flags);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SourceReadIssue('source-changed', displayPath);
    }
    throw cause;
  }
  try {
    identity(fstatSync(fd, { bigint: true }), boundary, displayPath);
    return fd;
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}

function stable(
  fd: number,
  before: BigIntStats,
  boundary: SourceReadBoundary,
  displayPath: string,
  bytesRead: number,
): void {
  const after = fstatSync(fd, { bigint: true });
  identity(after, boundary, displayPath);
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    BigInt(bytesRead) !== after.size
  ) {
    throw new SourceReadIssue('source-changed', displayPath);
  }
}

export async function* sourceChunks(
  fd: number,
  boundary: SourceReadBoundary,
  displayPath: string,
): AsyncGenerator<Uint8Array> {
  const before = fstatSync(fd, { bigint: true });
  identity(before, boundary, displayPath);
  let position = 0;
  for (;;) {
    const buffer = new Uint8Array(Math.min(64 * 1024, boundary.maximumBytes - position + 1));
    const bytesRead = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, 0, buffer.length, position, (error, length) => {
        if (error !== null) reject(error);
        else resolve(length);
      });
    });
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > boundary.maximumBytes) {
      throw new SourceReadIssue('artifact-too-large', displayPath);
    }
    yield buffer.subarray(0, bytesRead);
  }
  stable(fd, before, boundary, displayPath, position);
}

export function sourceBytes(
  fd: number,
  boundary: SourceReadBoundary,
  displayPath: string,
): Uint8Array {
  const before = fstatSync(fd, { bigint: true });
  identity(before, boundary, displayPath);
  const bytes = new Uint8Array(Number(before.size));
  let position = 0;
  while (position < bytes.length) {
    const length = readSync(
      fd,
      bytes,
      position,
      Math.min(64 * 1024, bytes.length - position),
      position,
    );
    if (length === 0) break;
    position += length;
  }
  const extra = readSync(fd, new Uint8Array(1), 0, 1, position);
  stable(fd, before, boundary, displayPath, position + extra);
  return bytes;
}
