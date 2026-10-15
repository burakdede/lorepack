import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import { extractVerifiedArchive, verifyArchive, writeArchive } from '../src/archive.js';
import * as verification from '../src/archive-verification.js';
import { validBuild } from './archive_fixture.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const members = (root: string) => validBuild(root).map(([path, bytes]) => ({ path, bytes }));

async function damagedArchive(path: string, root: string): Promise<void> {
  const original = members(root);
  const zip = new yazl.ZipFile();
  for (const member of original) {
    zip.addBuffer(
      Buffer.from(member.path === 'manifest.json' ? encode('changed') : member.bytes),
      member.path,
    );
  }
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        algorithm: 'sha256',
        members: Object.fromEntries(
          original.map((member) => [member.path, sha256Hex(member.bytes)]),
        ),
      }),
    ),
    'checksums.json',
  );
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

describe('verified archive extraction', () => {
  it('extracts the private snapshot after the sender replaces the source archive', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'sender.lorepack');
      const replacement = join(project.root, 'replacement.lorepack');
      const destination = join(project.root, 'extracted');
      const original = validBuild(project.root, 'original').map(([path, bytes]) => ({
        path,
        bytes,
      }));
      const originalManifest = original.find((member) => member.path === 'manifest.json');
      if (originalManifest === undefined) throw new Error('The fixture must include its manifest.');
      await writeArchive(archive, original);
      const next = validBuild(project.root, 'replacement').map(([path, bytes]) => ({
        path,
        bytes,
      }));
      await writeArchive(replacement, next);
      const replacementBytes = readFileSync(replacement);
      const verify = verification.verifyCatalogFiles;
      const intercepted = vi
        .spyOn(verification, 'verifyCatalogFiles')
        .mockImplementation(async (directory) => {
          writeFileSync(archive, replacementBytes);
          return await verify(directory);
        });
      try {
        const result = await extractVerifiedArchive(archive, destination);
        expect(result.buildId).toBe(
          JSON.parse(Buffer.from(originalManifest.bytes).toString('utf8')).buildId,
        );
        expect(readFileSync(join(destination, 'build', 'manifest.json'))).toEqual(
          Buffer.from(originalManifest.bytes),
        );
        expect(readFileSync(archive)).toEqual(replacementBytes);
        expect(intercepted).toHaveBeenCalledOnce();
      } finally {
        intercepted.mockRestore();
      }
    });
  });

  it('removes the temporary output when archive replacement fails', async () => {
    await withTempProject({}, async (project) => {
      const destination = join(project.root, 'existing-directory');
      mkdirSync(destination);
      writeFileSync(join(destination, 'owned.txt'), 'existing content');
      const payload = members(project.root);
      const before = readdirSync(project.root).sort();
      await expect(writeArchive(destination, payload)).rejects.toBeDefined();
      expect(readFileSync(join(destination, 'owned.txt'), 'utf8')).toBe('existing content');
      expect(readdirSync(project.root).sort()).toEqual(before);
    });
  });

  it('extracts verified build, report and addressed object bytes without source originals', async () => {
    await withTempProject({}, async (project) => {
      const object = encode('retained normalized object');
      const hash = sha256Hex(object);
      const objectPath = `objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
      const payload = [
        ...members(project.root),
        { path: 'reports/validation.json', bytes: encode('{"ok":true}\n') },
        { path: objectPath, bytes: object },
        { path: 'originals/source.md', bytes: encode('source original') },
      ];
      const archive = join(project.root, 'valid.lorepack');
      const destination = join(project.root, 'extracted');
      await writeArchive(archive, payload);
      const before = readFileSync(archive);
      const result = await extractVerifiedArchive(archive, destination);
      expect(result).toMatchObject({
        ok: true,
        assurance: 'integrity-only',
        authenticated: false,
        memberCount: payload.length + 1,
      });
      for (const member of payload.filter((member) => !member.path.startsWith('originals/'))) {
        const target = join(
          destination,
          ...(member.path.startsWith('objects/') ? [member.path] : ['build', member.path]),
        );
        expect(readFileSync(target)).toEqual(Buffer.from(member.bytes));
        if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
      }
      expect(existsSync(join(destination, 'originals'))).toBe(false);
      expect(existsSync(join(destination, 'input.lorepack'))).toBe(false);
      if (process.platform !== 'win32') expect(statSync(destination).mode & 0o777).toBe(0o700);
      expect(readFileSync(archive)).toEqual(before);
    });
  });

  it.each(['unexpected.txt', 'reports/.hidden', 'reports/nested/result.json'])(
    'rejects supported checksums with unsupported member %s and removes staging',
    async (path) => {
      await withTempProject({}, async (project) => {
        const archive = join(project.root, 'layout.lorepack');
        const destination = join(project.root, 'extracted');
        await writeArchive(archive, [...members(project.root), { path, bytes: encode('extra') }]);
        expect((await verifyArchive(archive)).ok).toBe(true);
        const before = readFileSync(archive);
        await expect(extractVerifiedArchive(archive, destination)).rejects.toMatchObject({
          code: 'LORE_E_SCHEMA_MISMATCH',
          subject: path,
        });
        expect(existsSync(destination)).toBe(false);
        expect(readFileSync(archive)).toEqual(before);
      });
    },
  );

  it('rejects a checksummed object with an incorrect content address and removes staging', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'address.lorepack');
      const destination = join(project.root, 'extracted');
      const path = `objects/sha256/00/00/${'0'.repeat(60)}`;
      await writeArchive(archive, [
        ...members(project.root),
        { path, bytes: encode('not the named hash') },
      ]);
      expect((await verifyArchive(archive)).ok).toBe(true);
      await expect(extractVerifiedArchive(archive, destination)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        subject: path,
      });
      expect(existsSync(destination)).toBe(false);
    });
  });

  it('removes the private snapshot after member verification fails', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'damaged.lorepack');
      const destination = join(project.root, 'extracted');
      await damagedArchive(archive, project.root);
      const before = readFileSync(archive);
      await expect(extractVerifiedArchive(archive, destination)).rejects.toMatchObject({
        code: 'LORE_E_OBJECT_CORRUPT',
        details: {
          failures: [
            expect.objectContaining({ member: 'manifest.json', reason: 'checksum-mismatch' }),
          ],
        },
      });
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(archive)).toEqual(before);
    });
  });

  it('preserves a pre-existing destination and its contents', async () => {
    await withTempProject({}, async (project) => {
      const archive = join(project.root, 'valid.lorepack');
      const destination = join(project.root, 'existing');
      await writeArchive(archive, members(project.root));
      mkdirSync(destination);
      const sentinel = join(destination, 'owned.txt');
      writeFileSync(sentinel, 'existing content');
      await expect(extractVerifiedArchive(archive, destination)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(readFileSync(sentinel, 'utf8')).toBe('existing content');
    });
  });
});
