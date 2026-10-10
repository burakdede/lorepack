import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LoreError, sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { ARCHIVE_LIMITS, readArchive, verifyArchive } from '../src/archive.js';

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
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of members) zip.addBuffer(Buffer.from(bytes), name);
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

      await expect(verifyArchive(archive)).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_OBJECT_CORRUPT',
      });
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

      await expect(verifyArchive(archive)).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxTotalBytes' }),
      });
      await expect(readArchive(archive)).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_LIMIT_EXCEEDED',
      });
    });
  });

  it('refuses one member past the per-member limit', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'member.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxMemberBytes: 8 } }),
      ).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxMemberBytes', member: 'manifest.json' }),
      });
    });
  });

  it('refuses more members than the limit before reading any of them', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'count.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxMembers: 2 } }),
      ).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxMembers' }),
      });
    });
  });

  it('refuses a checksum index larger than its own limit', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'index.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);

      await expect(
        verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxIndexBytes: 16 } }),
      ).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limit: 'maxIndexBytes' }),
      });
    });
  });

  it('reports a member that inflates past its declared size as corrupt', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'liar.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);
      declareSize(archive, 'context.sqlite', 4);

      await expect(verifyArchive(archive)).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: 'context.sqlite',
      });
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

      await expect(verifyArchive(archive)).rejects.toMatchObject<Partial<LoreError>>({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: 'checksums.json',
      });
    });
  });

  it('verifies an intact archive by streaming, and reports a mismatch by name', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'intact.lorepack');
      await writeZip(archive, [...BUILD, ['checksums.json', indexOf(BUILD)]]);
      expect(await verifyArchive(archive)).toEqual({ ok: true, memberCount: 3, failures: [] });

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
});
