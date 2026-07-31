import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { LoreError, sha256Hex } from '@lorepack/core';
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
    if (!existsSync(path)) continue;
    members.push({
      path: `objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`,
      bytes: new Uint8Array(readFileSync(path)),
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
 * Reads every member back and checks it against the recorded index.
 *
 * Reported in archive order and the first mismatch is the one that matters, so a corrupt
 * download says which file went wrong rather than "invalid archive".
 */
export async function verifyArchive(path: string): Promise<VerificationResult> {
  const members = await readArchive(path);
  const indexMember = members.get(CHECKSUM_MEMBER);
  if (indexMember === undefined) {
    throw new LoreError('LORE_E_OBJECT_CORRUPT', `${path} has no ${CHECKSUM_MEMBER}.`, {
      remediation: 'This is not a Lorepack archive, or it was truncated. Pack the build again.',
    });
  }

  let index: ChecksumIndex;
  try {
    index = JSON.parse(new TextDecoder().decode(indexMember)) as ChecksumIndex;
  } catch (cause) {
    throw new LoreError('LORE_E_OBJECT_CORRUPT', `${CHECKSUM_MEMBER} in ${path} is unreadable.`, {
      remediation: 'The archive is corrupt. Pack the build again.',
      cause,
    });
  }

  const failures: VerificationFailure[] = [];
  for (const [member, expected] of Object.entries(index.members)) {
    const bytes = members.get(member);
    if (bytes === undefined) {
      failures.push({ member, reason: 'missing', expected });
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== expected)
      failures.push({ member, reason: 'checksum-mismatch', expected, actual });
  }

  // A member nobody vouched for is as suspicious as a corrupt one: it means the archive
  // carries content the index does not describe.
  for (const member of members.keys()) {
    if (member === CHECKSUM_MEMBER) continue;
    if (!(member in index.members)) failures.push({ member, reason: 'unlisted' });
  }

  return { ok: failures.length === 0, memberCount: members.size, failures };
}

/** Reads an archive into memory. Archives are bounded by the build envelope, so this is
 *  simpler than streaming and the whole file is being hashed anyway. */
export function readArchive(path: string): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError !== null || zipfile === undefined) {
        reject(
          new LoreError('LORE_E_OBJECT_CORRUPT', `Cannot open ${path} as a ZIP archive.`, {
            remediation: 'The file is not an archive, or it is truncated.',
            ...(openError === null ? {} : { cause: openError }),
          }),
        );
        return;
      }

      const members = new Map<string, Uint8Array>();
      zipfile.on('error', (cause) =>
        reject(
          new LoreError('LORE_E_OBJECT_CORRUPT', `${path} is not a readable archive.`, {
            remediation: 'Download or pack the archive again.',
            cause,
          }),
        ),
      );
      zipfile.on('end', () => resolve(members));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        // A member whose compressed payload is damaged fails here, inside inflate. It is
        // corruption like any checksum mismatch, so it is reported as corruption naming
        // the member rather than as an unexplained internal error.
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

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            reject(corrupt(streamError));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', (cause) => reject(corrupt(cause)));
          stream.on('end', () => {
            members.set(entry.fileName, new Uint8Array(Buffer.concat(chunks)));
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });
}

/** Original source files, for `package.includeOriginals`. Paths are archive-relative. */
export function collectOriginals(
  projectRoot: string,
  relativePaths: readonly string[],
): ArchiveMember[] {
  const members: ArchiveMember[] = [];
  for (const relativePath of [...relativePaths].sort()) {
    const absolute = join(projectRoot, ...relativePath.split('/'));
    if (!existsSync(absolute)) continue;
    members.push({
      path: posix.join('originals', relativePath),
      bytes: new Uint8Array(readFileSync(absolute)),
    });
  }
  return members;
}

/** Normalizes a filesystem path into the POSIX form used inside an archive. */
export function archivePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
