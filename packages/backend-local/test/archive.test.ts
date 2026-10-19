import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type LoreError, sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  ARCHIVE_LIMITS,
  archivePath,
  collectBuildMembers,
  collectObjects,
  collectOriginals,
  readArchive,
  verifyArchive,
} from '../src/archive.js';
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

describe('archive identity and index boundaries', () => {
  it('refuses a complete ZIP without a checksum index', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'no-index.lorepack');
      await writeZip(archive, validBuild(project.root));
      await expect(verifyArchive(archive)).rejects.toMatchObject({ code: 'LORE_E_OBJECT_CORRUPT' });
      await expect(verifyArchive(archive)).rejects.toMatchObject({
        remediation: 'This is not a Lorepack archive, or it was truncated. Pack the build again.',
      });
    });
  });

  it('accepts a valid checksum index exactly at its declared byte limit', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'exact-index-limit.lorepack');
      const members = validBuild(project.root);
      const index = Buffer.concat([Buffer.from(indexOf(members)), Buffer.from(' '.repeat(4096))]);
      await writeZip(archive, [...members, ['checksums.json', index]]);
      const result = await verifyArchive(archive, {
        limits: { ...ARCHIVE_LIMITS, maxIndexBytes: index.byteLength },
      });
      expect(result.ok).toBe(true);
      expect(result.failures).toEqual([]);
    });
  });

  it('requires retained identity inputs even when a legacy package has matching checksums', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'legacy.lorepack');
      const members = validBuild(project.root).filter(
        ([name]) => name !== 'reports/build-id-inputs.json',
      );
      await writeZip(archive, [...members, ['checksums.json', indexOf(members)]]);
      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_SCHEMA_MISMATCH',
        subject: 'reports/build-id-inputs.json',
      });
    });
  });

  it.each(['manifest.json', 'reports/build-id-inputs.json'])(
    'refuses checksummed but unsupported identity data in %s',
    async (name) => {
      await withTempProject({}, async (project) => {
        const archive = join(project.root, 'unsupported.lorepack');
        const members = validBuild(project.root).map(
          ([member, bytes]) =>
            [member, member === name ? new TextEncoder().encode('{}') : bytes] as const,
        );
        await writeZip(archive, [...members, ['checksums.json', indexOf(members)]]);
        await expect(verifyArchive(archive)).rejects.toMatchObject({
          code: 'LORE_E_SCHEMA_MISMATCH',
        });
      });
    },
  );

  it('names an unreadable checksum index as a corrupt package', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'bad-index.lorepack');
      await writeZip(archive, [
        ...validBuild(project.root),
        ['checksums.json', new TextEncoder().encode('{')],
      ]);
      await expect(verifyArchive(archive)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: 'checksums.json',
      });
    });
  });
});

describe('archive declared-member and metadata limits', () => {
  it('reports the expected digest of a listed member missing from the ZIP', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'missing-catalog.lorepack');
      const members = validBuild(project.root);
      const catalog = members.find(([name]) => name === 'context.sqlite');
      if (catalog === undefined) throw new Error('Expected a fixture catalog.');
      await writeZip(archive, [
        ...members.filter(([name]) => name !== 'context.sqlite'),
        ['checksums.json', indexOf(members)],
      ]);
      const result = await verifyArchive(archive);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual([
        { member: 'context.sqlite', reason: 'missing', expected: sha256Hex(catalog[1]) },
      ]);
    });
  });

  it.each(['manifest.json', 'reports/build-id-inputs.json'])(
    'applies the metadata byte limit to %s after checking the index',
    async (name) => {
      await withTempProject({}, async (project) => {
        const archive = join(project.root, 'large-metadata.lorepack');
        const members = validBuild(project.root);
        const peerBytes = Math.max(
          ...members
            .filter(([member]) => member !== name && member !== 'context.sqlite')
            .map(([, bytes]) => bytes.byteLength),
        );
        const padded = members.map(
          ([member, bytes]) =>
            [
              member,
              member === name
                ? new TextEncoder().encode(
                    `${new TextDecoder().decode(bytes)}${' '.repeat(peerBytes + 1024)}`,
                  )
                : bytes,
            ] as const,
        );
        const index = indexOf(padded);
        const maxIndexBytes = Math.max(index.byteLength, peerBytes);
        await writeZip(archive, [...padded, ['checksums.json', index]]);
        await expect(
          verifyArchive(archive, { limits: { ...ARCHIVE_LIMITS, maxIndexBytes } }),
        ).rejects.toMatchObject({
          code: 'LORE_E_LIMIT_EXCEEDED',
          subject: name,
          details: { limit: 'maxIndexBytes', value: maxIndexBytes, member: name },
        });
      });
    },
  );
});

describe('archive member collection', () => {
  it('collects a minimal build without reports or an explicit object list', async () => {
    await withTempProject(
      { files: { 'build/manifest.json': MANIFEST, 'build/context.sqlite': DATABASE } },
      async (project) => {
        expect(collectBuildMembers(project.path('build'))).toEqual([
          { path: 'manifest.json', bytes: MANIFEST },
          { path: 'context.sqlite', bytes: DATABASE },
        ]);
      },
    );
  });

  it('orders report files and objects while preserving binary bytes and caller order', async () => {
    const binary = new Uint8Array([0, 128, 255]);
    await withTempProject(
      {
        files: {
          'build/manifest.json': MANIFEST,
          'build/context.sqlite': DATABASE,
          'build/reports/z.json': binary,
          'build/reports/a.json': '{}\n',
        },
      },
      async (project) => {
        mkdirSync(project.path('build/reports/not-a-report'));
        const objects = [
          { path: 'objects/z', bytes: binary },
          { path: 'objects/a', bytes: new Uint8Array([1]) },
        ];
        const result = collectBuildMembers(project.path('build'), objects);
        expect(result.map((member) => member.path)).toEqual([
          'manifest.json',
          'context.sqlite',
          'reports/a.json',
          'reports/z.json',
          'objects/a',
          'objects/z',
        ]);
        expect(result.find((member) => member.path === 'reports/z.json')?.bytes).toEqual(binary);
        expect(result.find((member) => member.path === 'objects/z')?.bytes).toEqual(binary);
        expect(objects.map((member) => member.path)).toEqual(['objects/z', 'objects/a']);
      },
    );
  });

  it.each(['changed', 'removed', 'directory'] as const)(
    'refuses a source that was %s after its content hash was recorded',
    async (state) => {
      await withTempProject({ files: { 'source.md': 'recorded bytes' } }, async (project) => {
        const source = project.path('source.md');
        const contentHash = sha256Hex(readFileSync(source));
        if (state === 'changed') writeFileSync(source, 'new bytes');
        else {
          rmSync(source);
          if (state === 'directory') mkdirSync(source);
        }
        expect(() =>
          collectOriginals(project.root, [{ path: 'source.md', contentHash }]),
        ).toThrowError(
          expect.objectContaining({ code: 'LORE_E_STALE_SOURCES', path: 'source.md' }),
        );
        if (state === 'changed') expect(readFileSync(source, 'utf8')).toBe('new bytes');
        else if (state === 'directory') expect(statSync(source).isDirectory()).toBe(true);
        else expect(existsSync(source)).toBe(false);
      });
    },
  );

  it('retains original binary bytes in stable archive order without reordering the input', async () => {
    const binary = new Uint8Array([0, 128, 255]);
    await withTempProject(
      { files: { 'docs/z.bin': binary, 'docs/a.md': 'source' } },
      async (project) => {
        const originals = ['docs/z.bin', 'docs/a.md'].map((path) => ({
          path,
          contentHash: sha256Hex(readFileSync(project.path(path))),
        }));
        const result = collectOriginals(project.root, originals);
        expect(result.map((member) => member.path)).toEqual([
          'originals/docs/a.md',
          'originals/docs/z.bin',
        ]);
        expect(result[1]?.bytes).toEqual(binary);
        expect(originals.map((source) => source.path)).toEqual(['docs/z.bin', 'docs/a.md']);
        expect(archivePath(project.root, project.path('docs/a.md'))).toBe('docs/a.md');
      },
    );
  });
});

describe('archive object collection', () => {
  it.each(['intact', 'missing', 'changed'] as const)(
    'checks the %s addressed object before packaging',
    async (state) => {
      const bytes = new Uint8Array([0, 128, 255]);
      const hash = sha256Hex(bytes);
      const path = `objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
      await withTempProject({ files: { [path]: bytes } }, async (project) => {
        if (state === 'missing') rmSync(project.path(path));
        if (state === 'changed') writeFileSync(project.path(path), 'changed bytes');
        const collect = () => collectObjects(project.path('objects'), [hash, hash]);
        if (state === 'intact') {
          expect(collect()).toEqual([{ path, bytes }]);
          expect(readFileSync(project.path(path))).toEqual(Buffer.from(bytes));
        } else {
          expect(collect).toThrowError(
            expect.objectContaining({ code: 'LORE_E_OBJECT_CORRUPT', subject: hash }),
          );
          if (state === 'missing') expect(existsSync(project.path(path))).toBe(false);
          else expect(readFileSync(project.path(path), 'utf8')).toBe('changed bytes');
        }
      });
    },
  );
});
