import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { checksumIndexSchema, LoreError, sha256Hex } from '@lorepack/core';
import yauzl from 'yauzl';
import yazl from 'yazl';

/**
 * The `.lorepack` archive: a standard ZIP envelope, deliberately boring.
 *
 * Architecture section 22.3 makes this the anti-lock-in promise, so there is no
 * encryption and no proprietary framing: a plain `unzip` must be able to open it. Entry
 * order is fixed and timestamps are normalized, so packing the same build twice produces
 * the same bytes.
 *
 * Member checksums detect corruption. They are explicitly **not** the identity of the
 * build (section 11.3): identity comes from canonical logical content, and two machines
 * can legitimately produce different `context.sqlite` bytes for the same build.
 */

/** A fixed timestamp for every entry. Any real time would make output machine dependent. */
const NORMALIZED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export const CHECKSUM_MEMBER = 'checksums.json' as const;

export interface ArchiveMember {
  /** POSIX path inside the archive. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ChecksumIndex {
  readonly formatVersion: 1;
  readonly algorithm: 'sha256';
  readonly members: Readonly<Record<string, string>>;
}

/**
 * Collects a sealed build into archive members, in the documented stable order:
 * `manifest.json`, then the checksum index, then `context.sqlite`, then `reports/`, then
 * `objects/`, each group sorted by path.
 *
 * Manifest first so a consumer can read what this is without extracting the rest.
 */
export function collectBuildMembers(
  buildDirectory: string,
  objects: readonly ArchiveMember[] = [],
): ArchiveMember[] {
  const read = (relativePath: string): ArchiveMember => ({
    path: relativePath,
    bytes: new Uint8Array(readFileSync(join(buildDirectory, ...relativePath.split('/')))),
  });

  const members: ArchiveMember[] = [read('manifest.json'), read('context.sqlite')];

  const reports = join(buildDirectory, 'reports');
  if (existsSync(reports)) {
    for (const name of readdirSync(reports).sort()) {
      if (statSync(join(reports, name)).isFile()) members.push(read(`reports/${name}`));
    }
  }

  members.push(...[...objects].sort((a, b) => (a.path < b.path ? -1 : 1)));
  return members;
}

/** Every object referenced by a build, as archive members under `objects/`. */
export function collectObjects(
  objectsDirectory: string,
  hashes: readonly string[],
): ArchiveMember[] {
  const members: ArchiveMember[] = [];
  for (const hash of [...new Set(hashes)].sort()) {
    const path = join(
      objectsDirectory,
      'sha256',
      hash.slice(0, 2),
      hash.slice(2, 4),
      hash.slice(4),
    );
    if (!existsSync(path)) {
      throw new LoreError('LORE_E_OBJECT_CORRUPT', `Referenced object ${hash} is missing.`, {
        remediation: 'Restore the object or rebuild the project before packing.',
        subject: hash,
      });
    }
    const bytes = new Uint8Array(readFileSync(path));
    const actual = sha256Hex(bytes);
    if (actual !== hash) {
      throw new LoreError(
        'LORE_E_OBJECT_CORRUPT',
        `Referenced object ${hash} failed its checksum: found ${actual}.`,
        {
          remediation: 'Restore the object or rebuild the project before packing.',
          subject: hash,
        },
      );
    }
    members.push({
      path: `objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`,
      bytes,
    });
  }
  return members;
}

export function checksumIndex(members: readonly ArchiveMember[]): ChecksumIndex {
  const entries = members.map((member) => [member.path, sha256Hex(member.bytes)] as const);
  return {
    formatVersion: 1,
    algorithm: 'sha256',
    // Sorted so the index itself is stable regardless of collection order.
    members: Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export async function writeArchive(
  destination: string,
  members: readonly ArchiveMember[],
): Promise<void> {
  const index = checksumIndex(members);
  const indexBytes = new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`);

  // manifest.json, then the checksum index, then everything else in collection order.
  const ordered: ArchiveMember[] = [];
  const manifest = members.find((member) => member.path === 'manifest.json');
  if (manifest !== undefined) ordered.push(manifest);
  ordered.push({ path: CHECKSUM_MEMBER, bytes: indexBytes });
  ordered.push(...members.filter((member) => member.path !== 'manifest.json'));

  const zip = new yazl.ZipFile();
  for (const member of ordered) {
    // addBuffer with a known size and a fixed mtime: yazl then writes no data descriptor
    // and no local-header time drift, which is what makes two runs byte-identical.
    zip.addBuffer(Buffer.from(member.bytes), member.path, {
      mtime: NORMALIZED_MTIME,
      mode: 0o100644,
      compress: true,
    });
  }
  zip.end();

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(destination);
    out.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out);
  });
}

export interface VerificationFailure {
  readonly member: string;
  readonly reason: 'missing' | 'checksum-mismatch' | 'unlisted';
  readonly expected?: string;
  readonly actual?: string;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly memberCount: number;
  readonly failures: readonly VerificationFailure[];
}

/**
 * Caps on what an archive may declare, checked against the central directory before any member
 * is inflated.
 *
 * An archive is input someone handed you, so a 3 MB file that declares gigabytes must fail on
 * the declaration, not after the memory is spent. The declared sizes are trustworthy for this
 * purpose because yauzl fails any member that inflates past its declaration. The values leave
 * room above the scale envelope (2,500 files and 1 GB of sources): every member is read as a
 * stream, so they bound work rather than memory.
 */
export const ARCHIVE_LIMITS = {
  /** Entries in the central directory. An envelope build packs a few thousand. */
  maxMembers: 100_000,
  /** Declared uncompressed bytes of one member. `context.sqlite` is the large one. */
  maxMemberBytes: 4 * 1024 * 1024 * 1024,
  /** Declared uncompressed bytes across every member. */
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  /** `checksums.json`, the one member parsed whole rather than streamed. */
  maxIndexBytes: 16 * 1024 * 1024,
} as const;

export type ArchiveLimits = { readonly [K in keyof typeof ARCHIVE_LIMITS]: number };

export interface ArchiveReadOptions {
  readonly limits?: ArchiveLimits;
}

/**
 * Checks every member against the recorded index.
 *
 * Names are compared from the central directory first, so an unlisted member is reported
 * without being inflated. Listed members are hashed as they stream, so memory stays flat
 * whatever their size. Failures are reported in archive order, so a corrupt download says
 * which file went wrong rather than "invalid archive".
 */
export async function verifyArchive(
  path: string,
  options: ArchiveReadOptions = {},
): Promise<VerificationResult> {
  const limits = options.limits ?? ARCHIVE_LIMITS;
  const archive = await openArchive(path);
  try {
    const entries = await listEntries(archive, path, limits);
    const indexEntry = entries.find((entry) => entry.fileName === CHECKSUM_MEMBER);
    if (indexEntry === undefined) {
      throw new LoreError('LORE_E_OBJECT_CORRUPT', `${path} has no ${CHECKSUM_MEMBER}.`, {
        remediation: 'This is not a Lorepack archive, or it was truncated. Pack the build again.',
      });
    }
    if (indexEntry.uncompressedSize > limits.maxIndexBytes) {
      throw limitExceeded(path, 'maxIndexBytes', limits.maxIndexBytes, CHECKSUM_MEMBER);
    }
    const index = parseIndex(path, await readEntry(archive, path, indexEntry));

    const failures: VerificationFailure[] = [];
    const present = new Set<string>();
    for (const entry of entries) {
      const member = entry.fileName;
      if (member === CHECKSUM_MEMBER) continue;
      present.add(member);
      // A member nobody vouched for is as suspicious as a corrupt one: it means the archive
      // carries content the index does not describe.
      const expected = index.get(member);
      if (expected === undefined) {
        failures.push({ member, reason: 'unlisted' });
        continue;
      }
      const hash = createHash('sha256');
      await streamEntry(archive, path, entry, (chunk) => hash.update(chunk));
      const actual = hash.digest('hex');
      if (actual !== expected) {
        failures.push({ member, reason: 'checksum-mismatch', expected, actual });
      }
    }
    for (const [member, expected] of index) {
      if (!present.has(member)) failures.push({ member, reason: 'missing', expected });
    }

    return { ok: failures.length === 0, memberCount: entries.length, failures };
  } finally {
    archive.close();
  }
}

/**
 * Reads an archive into memory, member by member.
 *
 * The same central-directory limits apply as for verification, so nothing is inflated from an
 * archive that declares more than Lorepack will read. Use `verifyArchive` first on anything
 * received from elsewhere: this returns bytes, not trust.
 */
export async function readArchive(
  path: string,
  options: ArchiveReadOptions = {},
): Promise<Map<string, Uint8Array>> {
  const archive = await openArchive(path);
  try {
    const members = new Map<string, Uint8Array>();
    for (const entry of await listEntries(archive, path, options.limits ?? ARCHIVE_LIMITS)) {
      members.set(entry.fileName, await readEntry(archive, path, entry));
    }
    return members;
  } finally {
    archive.close();
  }
}

function parseIndex(path: string, bytes: Uint8Array): Map<string, string> {
  const invalid = (cause: unknown): LoreError =>
    new LoreError('LORE_E_OBJECT_CORRUPT', `${CHECKSUM_MEMBER} in ${path} is unreadable.`, {
      remediation: 'The archive is corrupt. Pack the build again.',
      subject: CHECKSUM_MEMBER,
      cause,
    });
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw invalid(cause);
  }
  const parsed = checksumIndexSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  // A Map, because a plain object answers `in` and indexing for `constructor` and friends.
  return new Map(Object.entries(parsed.data.members));
}

function openArchive(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // autoClose off: members are opened after the directory has been read and checked.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (openError, zipfile) => {
      if (openError !== null || zipfile === undefined) {
        reject(
          new LoreError('LORE_E_OBJECT_CORRUPT', `Cannot open ${path} as a ZIP archive.`, {
            remediation: 'The file is not an archive, or it is truncated.',
            ...(openError === null ? {} : { cause: openError }),
          }),
        );
        return;
      }
      resolve(zipfile);
    });
  });
}

/** The central directory, in archive order, checked against the limits. Inflates nothing. */
function listEntries(
  archive: yauzl.ZipFile,
  path: string,
  limits: ArchiveLimits,
): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    if (archive.entryCount > limits.maxMembers) {
      reject(limitExceeded(path, 'maxMembers', limits.maxMembers));
      return;
    }
    const entries: yauzl.Entry[] = [];
    const names = new Set<string>();
    let total = 0;
    archive.on('error', (cause) =>
      reject(
        new LoreError('LORE_E_OBJECT_CORRUPT', `${path} is not a readable archive.`, {
          remediation: 'Download or pack the archive again.',
          cause,
        }),
      ),
    );
    archive.on('end', () => resolve(entries));
    archive.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (name.endsWith('/')) {
        archive.readEntry();
        return;
      }
      if (names.has(name)) {
        reject(
          new LoreError('LORE_E_OBJECT_CORRUPT', `${name} appears more than once in ${path}.`, {
            remediation: 'The archive contains duplicate members. Pack the build again.',
            subject: name,
          }),
        );
        return;
      }
      if (entry.uncompressedSize > limits.maxMemberBytes) {
        reject(limitExceeded(path, 'maxMemberBytes', limits.maxMemberBytes, name));
        return;
      }
      total += entry.uncompressedSize;
      if (total > limits.maxTotalBytes) {
        reject(limitExceeded(path, 'maxTotalBytes', limits.maxTotalBytes));
        return;
      }
      names.add(name);
      entries.push(entry);
      archive.readEntry();
    });
    archive.readEntry();
  });
}

async function readEntry(
  archive: yauzl.ZipFile,
  path: string,
  entry: yauzl.Entry,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  await streamEntry(archive, path, entry, (chunk) => chunks.push(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function streamEntry(
  archive: yauzl.ZipFile,
  path: string,
  entry: yauzl.Entry,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  // A member whose compressed payload is damaged, or that inflates past its declared size,
  // fails here. It is corruption like any checksum mismatch, so it is reported as corruption
  // naming the member rather than as an unexplained internal error.
  const corrupt = (cause: unknown): LoreError =>
    new LoreError(
      'LORE_E_OBJECT_CORRUPT',
      `${entry.fileName} in ${path} could not be read: the archive is damaged.`,
      {
        remediation: 'Download or pack the archive again. Its contents cannot be trusted.',
        subject: entry.fileName,
        ...(cause === null || cause === undefined ? {} : { cause }),
      },
    );
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (streamError, stream) => {
      if (streamError !== null || stream === undefined) {
        reject(corrupt(streamError));
        return;
      }
      stream.on('data', onChunk);
      stream.on('error', (cause) => reject(corrupt(cause)));
      stream.on('end', () => resolve());
    });
  });
}

function limitExceeded(
  path: string,
  limit: keyof ArchiveLimits,
  value: number,
  member?: string,
): LoreError {
  const what = member === undefined ? path : `${member} in ${path}`;
  return new LoreError(
    'LORE_E_LIMIT_EXCEEDED',
    `${what} declares more than Lorepack will read (${limit} is ${String(value)}).`,
    {
      remediation:
        'An archive this large is not one Lorepack writes. It may be a decompression bomb; do not trust it.',
      ...(member === undefined ? {} : { subject: member }),
      details: { limit, value, ...(member === undefined ? {} : { member }) },
    },
  );
}

export interface OriginalSource {
  /** POSIX path relative to the project root: the artifact's display path. */
  readonly path: string;
  /** The artifact's recorded `content_hash`, the SHA-256 of the bytes the build read. */
  readonly contentHash: string;
}

/**
 * Original source files, for `package.includeOriginals`, at `originals/<project path>`.
 *
 * They are read from the live tree, long after discovery checked it, so each one is checked
 * again: it must not be a link, its real path must stay inside the project, and its bytes must
 * hash to what the build recorded. Anything else refuses the pack. An archive presents these
 * as the build's originals (invariant 5), and packing whatever is there now, or quietly leaving
 * a file out, would make that claim false. Retaining originals at build time (#420) removes
 * the live read altogether.
 */
export function collectOriginals(
  projectRoot: string,
  originals: readonly OriginalSource[],
): ArchiveMember[] {
  const realRoot = realpathSync(projectRoot);
  const members: ArchiveMember[] = [];
  for (const original of [...originals].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const absolute = join(projectRoot, ...original.path.split('/'));
    const changed = (detail: string, cause?: unknown): LoreError =>
      new LoreError(
        'LORE_E_STALE_SOURCES',
        `${original.path} ${detail} since the build, so its original cannot be packed.`,
        {
          remediation:
            'Run `lorepack build` and pack the new build, or set package.includeOriginals: false to pack this build without originals.',
          path: original.path,
          ...(cause === undefined ? {} : { cause }),
        },
      );

    let link: ReturnType<typeof lstatSync>;
    let real: string;
    try {
      link = lstatSync(absolute);
      real = realpathSync(absolute);
    } catch (cause) {
      throw changed('was removed or became unreadable', cause);
    }
    if (link.isSymbolicLink() || !isWithin(realRoot, real)) {
      throw new LoreError(
        'LORE_E_PATH_ESCAPE',
        link.isSymbolicLink()
          ? `${original.path} is now a symbolic link, so its original cannot be packed.`
          : `${original.path} now resolves outside the project, so its original cannot be packed.`,
        {
          remediation:
            'Replace the link with the file itself and rebuild, or set package.includeOriginals: false.',
          path: original.path,
        },
      );
    }
    if (!link.isFile()) throw changed('is no longer a regular file');

    const bytes = new Uint8Array(readFileSync(real));
    if (sha256Hex(bytes) !== original.contentHash) throw changed('changed');
    members.push({ path: posix.join('originals', original.path), bytes });
  }
  return members;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate).split(sep).join('/');
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

/** Normalizes a filesystem path into the POSIX form used inside an archive. */
export function archivePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
