import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildManifestSchema } from '@lorepack/core';
import { makePdf, withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function cli(root: string, args: string[]) {
  return execute(process.execPath, [BINARY, '--cwd', root, ...args], { timeout: 30_000 });
}

it('preserves exact unread PDF pages through a cached build and source-free inspection', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: coverage\nsources: [docs]\n',
        'docs/mixed.pdf': '',
      },
    },
    async (temp) => {
      writeFileSync(
        temp.path('docs/mixed.pdf'),
        makePdf([
          { lines: [], image: true },
          { lines: ['Readable context.'] },
          { lines: [], image: true },
        ]),
      );
      const first = JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout);
      const cached = JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout);
      expect(cached.buildId).toBe(first.buildId);
      expect(cached.reusedArtifacts).toBe(1);
      expect(cached.rebuiltArtifacts).toBe(0);
      expect(cached.warnings).toBe(1);
      const manifest = buildManifestSchema.parse(
        JSON.parse(readFileSync(temp.path(`.lore/builds/${first.buildId}/manifest.json`), 'utf8')),
      );
      const warning = manifest.warnings.find((item) => item.code === 'pdf-pages-without-text');
      expect(warning).toMatchObject({
        class: 'parser',
        path: 'docs/mixed.pdf',
        message: expect.stringContaining('Pages: 1, 3.'),
      });
      const report = JSON.parse(
        readFileSync(temp.path(`.lore/builds/${first.buildId}/reports/warnings.json`), 'utf8'),
      );
      expect(report).toContainEqual(warning);
      rmSync(temp.path('docs/mixed.pdf'));
      const inspected = JSON.parse(
        (await cli(temp.root, ['--json', 'inspect', 'warnings'])).stdout,
      );
      expect(inspected.warnings).toContainEqual(warning);
      expect((await cli(temp.root, ['inspect', 'warnings'])).stdout).toContain('Pages: 1, 3.');
    },
  );
});
