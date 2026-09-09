import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { type LoreError, sha256Hex } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { verifyArchive } from '../src/archive.js';

async function writeDuplicateArchive(path: string): Promise<void> {
  const manifest = new TextEncoder().encode('{"buildId":"lore_test"}\n');
  const database = new TextEncoder().encode('SQLite format 3');
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
});
