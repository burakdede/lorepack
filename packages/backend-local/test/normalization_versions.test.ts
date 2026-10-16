import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildIdInputs, deriveBuildId, sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { extractVerifiedArchive, readArchive, verifyArchive } from '../src/archive.js';
import { validBuild } from './archive_fixture.js';

function indexOf(members: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ formatVersion: 1, algorithm: 'sha256', members: Object.fromEntries(members.map(([name, bytes]) => [name, sha256Hex(bytes)])) })}\n`,
  );
}

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

describe('recorded normalization policies', () => {
  it.each([1, 2, 99])(
    'validates recorded normalization version %i without rewriting it',
    async (normalizationVersion) => {
      await withTempProject({}, async (project) => {
        const members = validBuild(project.root);
        const encoded = members.find(([name]) => name === 'reports/build-id-inputs.json')?.[1];
        if (encoded === undefined) throw new Error('Fixture identity inputs are missing.');
        const inputs = JSON.parse(new TextDecoder().decode(encoded)) as BuildIdInputs;
        const versioned = { ...inputs, normalizationVersion };
        const build = members.map(([name, bytes]) => {
          if (name === 'reports/build-id-inputs.json') {
            return [name, new TextEncoder().encode(`${JSON.stringify(versioned)}\n`)] as const;
          }
          if (name === 'manifest.json') {
            const manifest = JSON.parse(new TextDecoder().decode(bytes));
            manifest.buildId = deriveBuildId(versioned);
            return [name, new TextEncoder().encode(`${JSON.stringify(manifest)}\n`)] as const;
          }
          return [name, bytes] as const;
        });
        const archive = join(project.root, 'versioned.lorepack');
        await writeZip(archive, [...build, ['checksums.json', indexOf(build)]]);
        const before = sha256Hex(readFileSync(archive));
        if (normalizationVersion === 99) {
          await expect(verifyArchive(archive)).rejects.toMatchObject({
            code: 'LORE_E_SCHEMA_MISMATCH',
          });
          await expect(
            extractVerifiedArchive(archive, join(project.root, 'admitted')),
          ).rejects.toMatchObject({
            code: 'LORE_E_SCHEMA_MISMATCH',
          });
        } else {
          expect(await verifyArchive(archive)).toMatchObject({ ok: true });
          expect(
            await extractVerifiedArchive(archive, join(project.root, 'admitted')),
          ).toMatchObject({ ok: true });
          expect((await readArchive(archive)).get('reports/build-id-inputs.json')).toEqual(
            build.find(([name]) => name === 'reports/build-id-inputs.json')?.[1],
          );
        }
        expect(sha256Hex(readFileSync(archive))).toBe(before);
      });
    },
  );
});
