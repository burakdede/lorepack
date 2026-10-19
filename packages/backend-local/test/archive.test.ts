import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LoreError, sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { ARCHIVE_LIMITS, readArchive, verifyArchive } from '../src/archive.js';
import { validBuild } from './archive_fixture.js';

const MANIFEST = new TextEncoder().encode('{"buildId":"lore_test"}\n');
const DATABASE = new TextEncoder().encode('SQLite format 3');

function indexOf(
  members: ReadonlyArray<readonly [string, Uint8Array]>,
  overrides: Record<string, unknown> = {},
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      formatVersion: 1,
      algorithm: 'sha256',
      members: Object.fromEntries(members.map(([name, bytes]) => [name, sha256Hex(bytes)])),
      ...overrides,
    })}\n`,
  );
}

const BUILD: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['manifest.json', MANIFEST],
  ['context.sqlite', DATABASE],
];

async function writeZip(
  path: string,
  members: ReadonlyArray<readonly [string, Uint8Array]>,
  modes: ReadonlyMap<string, number> = new Map(),
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of members) {
    const mode = modes.get(name);
    const options = mode === undefined ? {} : { mode };
    if (name.endsWith('/')) zip.addEmptyDirectory(name, options);
    else zip.addBuffer(Buffer.from(bytes), name, options);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

/**
 * Rewrites the uncompressed size a member declares in the central directory, which is the
 * number a reader sees before it inflates anything. A real bomb declares its size honestly
 * (yauzl refuses a member that inflates past its declaration), so declaring the size is
 * enough to stand in for gigabytes of compressed zeros without writing them.
 */
function declareSize(path: string, member: string, size: number): void {
  const bytes = readFileSync(path);
  let patched = false;
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.toString('utf8', offset + 46, offset + 46 + nameLength) !== member) continue;
    bytes.writeUInt32LE(size, offset + 24);
    patched = true;
  }
  if (!patched) throw new Error(`${member} has no central directory record in ${path}`);
  writeFileSync(path, bytes);
}

function declareHost(path: string, member: string, host: number): void {
  const bytes = readFileSync(path);
  let patched = false;
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.toString('utf8', offset + 46, offset + 46 + nameLength) !== member) continue;
    bytes[offset + 5] = host;
    patched = true;
  }
  if (!patched) throw new Error(`${member} has no central directory record in ${path}`);
  writeFileSync(path, bytes);
}

async function writeDuplicateArchive(path: string): Promise<void> {
  const manifest = MANIFEST;
  const database = DATABASE;
  const index = new TextEncoder().encode(
    `${JSON.stringify(
      {
        formatVersion: 1,
        algorithm: 'sha256',
        members: {
          'context.sqlite': sha256Hex(database),
          'manifest.json': sha256Hex(manifest),
        },
      },
      null,
      2,
    )}\n`,
  );
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('tampered'), 'manifest.json');
  zip.addBuffer(Buffer.from(manifest), 'manifest.json');
  zip.addBuffer(Buffer.from(database), 'context.sqlite');
  zip.addBuffer(Buffer.from(index), 'checksums.json');
  zip.end();

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

describe('archive verification', () => {
  it('rejects duplicate ZIP members instead of hiding one', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'duplicate.lorepack');
      await writeDuplicateArchive(archive);

      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
      } satisfies Partial<LoreError>);
    });
  });

  it('fails members named after Object.prototype keys as unlisted', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'extra.lorepack');
      const extras = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
      await writeZip(archive, [
        ...BUILD,
        ['checksums.json', indexOf(BUILD)],
        ...extras.map((name) => [name, new TextEncoder().encode('smuggled')] as const),
      ]);

      const result = await verifyArchive(archive);

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual(extras.map((member) => ({ member, reason: 'unlisted' })));
    });
  });

  it('fails a __proto__ member as unlisted even when the index names it', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'proto.lorepack');
      const smuggled = new TextEncoder().encode('smuggled');
      const listed = [...BUILD, ['__proto__', smuggled] as const];
      await writeZip(archive, [...listed, ['checksums.json', indexOf(listed)]]);

      const result = await verifyArchive(archive);

      expect(result.failures).toEqual([{ member: '__proto__', reason: 'unlisted' }]);
    });
  });

  it('never inflates an unlisted member', async () => {
    // The unlisted member's payload is damaged. Inflating it would throw a corruption error;
    // reporting it as unlisted proves the decision was made from the central directory.
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'unlisted.lorepack');
      const payload = new Uint8Array(4096).fill(7);
      await writeZip(archive, [
        ...BUILD,
        ['checksums.json', indexOf(BUILD)],
        ['zz-unlisted.bin', payload],
      ]);
      declareSize(archive, 'zz-unlisted.bin', 16);

      const result = await verifyArchive(archive);

      expect(result.failures).toEqual([{ member: 'zz-unlisted.bin', reason: 'unlisted' }]);
    });
  });

  it('refuses a bomb with a typed limit error before inflating it', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'bomb.lorepack');
      const zeros = new Uint8Array(1024);
      // Five members of almost 4 GiB each: under the per-member cap, far over the total.
      const bombs = ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin'].map(
        (name) => [name, zeros] as const,
      );
      await writeZip(archive, [
        ...BUILD,
        ['checksums.json', indexOf([...BUILD, ...bombs])],
        ...bombs,
      ]);
      for (const [name] of bombs) declareSize(archive, name, 0xfffffff0);

      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxTotalBytes' }),
      } satisfies Partial<LoreError>);
      await expect(readArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
      } satisfies Partial<LoreError>);
    });
  });

  it('refuses one member past the per-member limit', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'member.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxMemberBytes: 8 } }),
      ).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxMemberBytes', member: 'manifest.json' }),
      } satisfies Partial<LoreError>);
    });
  });

  it('refuses an excessive declared compression ratio before reading a payload, issue 419', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'ratio.lorepack');
      const members = [...BUILD, ['payload.bin', new Uint8Array(1024)] as const];
      await writeZip(archive, [...members, ['checksums.json', indexOf(members)]]);
      declareSize(archive, 'payload.bin', 16 * 1024 * 1024);
      await expect(readArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxCompressionRatio' }),
      } satisfies Partial<LoreError>);
    });
  });

  it('accepts valid highly compressible members within the expansion limits, issue 419', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'compressible.lorepack');
      const bytes = new Uint8Array(8 * 1024 * 1024);
      const members = [...BUILD, ['payload.bin', bytes] as const];
      await writeZip(archive, [...members, ['checksums.json', indexOf(members)]]);
      const actual = (await readArchive(archive)).get('payload.bin');
      expect(actual).toBeDefined();
      expect(Buffer.from(actual as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    });
  });

  it('refuses more members than the limit before reading any of them', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'count.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxMembers: 2 } }),
      ).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxMembers' }),
      } satisfies Partial<LoreError>);
    });
  });

  it('refuses a checksum index larger than its own limit', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'index.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxIndexBytes: 16 } }),
      ).rejects.toMatchObject({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxIndexBytes' }),
      } satisfies Partial<LoreError>);
    });
  });

  it('reports a member that inflates past its declared size as corrupt', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'liar.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);
      declareSize(archive, 'context.sqlite', 4);

      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: 'context.sqlite',
      } satisfies Partial<LoreError>);
    });
  });

  it.each([
    ['an unknown formatVersion', { formatVersion: 2 }],
    ['an unknown algorithm', { algorithm: 'md5' }],
    ['a digest that is not sha256 hex', { members: { 'manifest.json': 'not-a-digest' } }],
    ['an unknown field', { signature: 'trust me' }],
  ])('refuses a checksum index with %s', async (_label, overrides) => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'schema.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD, overrides)]]);

      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: 'checksums.json',
      } satisfies Partial<LoreError>);
    });
  });

  it('verifies an intact archive by streaming, and reports a mismatch by name', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'intact.lorepack');
      const build = validBuild(project.root);
      await writeZip(archive, [...build, ['checksums.json', indexOf(build)]]);
      expect(await verifyArchive(archive)).toMatchObject({
        ok: true,
        memberCount: 4,
        failures: [],
        assurance: 'integrity-only',
        authenticated: false,
      });

      const tampered = join(project.root, 'tampered.lorepack');
      await writeZip(tampered, [
        ['manifest.json', MANIFEST],
        ['context.sqlite', new TextEncoder().encode('SQLite format 4')],
        ['checksums.json', indexOf(BUILD)],
      ]);
      expect((await verifyArchive(tampered)).failures).toEqual([
        {
          member: 'context.sqlite',
          reason: 'checksum-mismatch',
          expected: sha256Hex(DATABASE),
          actual: sha256Hex(new TextEncoder().encode('SQLite format 4')),
        },
      ]);
    });
  });

  it.each([
    ['a symbolic link', 0o120777, 3],
    ['a Darwin symbolic link', 0o120777, 19],
    ['a named pipe', 0o010644, 3],
    ['a character device', 0o020644, 3],
  ])('refuses %s entry before reading anything', async (_label, mode, host) => {
    // A link to /etc/passwd is a few harmless bytes to a verifier and a traversal to anything
    // that extracts the archive (#419), so it is refused from the central directory.
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'link.lorepack');
      const target = new TextEncoder().encode('/etc/passwd');
      const listed = [...BUILD, ['reports/link', target] as const];
      await writeZip(
        archive,
        [...listed, ['checksums.json', indexOf(listed)]],
        new Map([['reports/link', mode]]),
      );
      declareHost(archive, 'reports/link', host);

      for (const read of [verifyArchive, readArchive]) {
        await expect(read(archive)).rejects.toMatchObject({
          code: 'LORE_E_OBJECT_CORRUPT',
          subject: 'reports/link',
        } satisfies Partial<LoreError>);
      }
    });
  });

  it('fails an archive that carries no build, however consistent its index', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'empty.lorepack');
      await writeZip(archive, [['checksums.json', indexOf([])]]);

      const result = await verifyArchive(archive);

      expect(result.ok).toBe(false);
      expect(result.failures).toEqual([
        { member: 'manifest.json', reason: 'missing' },
        { member: 'context.sqlite', reason: 'missing' },
      ]);
    });
  });

  it('refuses a link disguised as a directory before skipping directory entries (#418)', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'directory-link.lorepack');
      await writeZip(
        archive,
        [...BUILD, ['checksums.json', indexOf(BUILD)], ['reports/link/', new Uint8Array()]],
        new Map([['reports/link/', 0o120777]]),
      );
      for (const read of [verifyArchive, readArchive]) {
        await expect(read(archive)).rejects.toMatchObject({
          code: 'LORE_E_OBJECT_CORRUPT',
          subject: 'reports/link/',
        } satisfies Partial<LoreError>);
      }
    });
  });

  it.each([0, 3, 19])(
    'preserves regular files from ZIP host %i and harmless directories',
    async (host) => {
      await withTempProject({}, async (project) => {
        const archive = join(project.root, 'directory.lorepack');
        const build = validBuild(project.root);
        await writeZip(archive, [
          ...build,
          ['checksums.json', indexOf(build)],
          ['reports/', new Uint8Array()],
        ]);
        declareHost(archive, 'manifest.json', host);
        expect(await verifyArchive(archive)).toMatchObject({
          ok: true,
          memberCount: 4,
          failures: [],
        });
        expect((await readArchive(archive)).get('manifest.json')).toEqual(build[0]?.[1]);
      });
    },
  );

  it('fails an archive whose index leaves out the catalog it does not carry', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'no-catalog.lorepack');
      const listed = [['manifest.json', MANIFEST] as const];
      await writeZip(archive, [...listed, ['checksums.json', indexOf(listed)]]);

      expect((await verifyArchive(archive)).failures).toEqual([
        { member: 'context.sqlite', reason: 'missing' },
      ]);
    });
  });
});
