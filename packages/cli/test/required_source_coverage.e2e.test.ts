import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildManifestSchema, loadProjectConfig } from '@lorepack/core';
import { makePdf, makeXlsx, number, row, withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { startServing } from '../src/services/serving.js';

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
      const server = await startServing({
        config: loadProjectConfig({ cwd: temp.root }),
        host: '127.0.0.1',
        port: 49_412,
        warn: () => {},
      });
      try {
        const response = await fetch(`${server.url}/v1/warnings`, {
          headers: { Connection: 'close' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          buildId: first.buildId,
          groups: [expect.objectContaining({ warnings: [warning] })],
        });
      } finally {
        await server.close();
      }
    },
  );
});

for (const format of ['pdf', 'xlsx'] as const) {
  it.each(['cold', 'cached'] as const)(
    `rejects incomplete required ${format} coverage with a %s parse cache before activation`,
    async (cache) => {
      await withTempProject(
        {
          files: {
            'lore.yaml': 'version: 1\nname: coverage\nsources: [docs]\n',
            'docs/notes.md': '# Active\n\nKeep this build readable.\n',
          },
        },
        async (temp) => {
          const base = 'version: 1\nname: coverage\nsources: [docs]\n';
          let active = JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout).buildId;
          const path = `docs/required.${format}`;
          writeFileSync(
            temp.path(path),
            format === 'pdf'
              ? makePdf([{ lines: ['Visible context.'] }, { lines: [], image: true }])
              : await makeXlsx({ sheets: [{ name: 'Revenue', rows: row(1, [number('A1', 42)]) }] }),
          );
          const required = `  required:\n    - path: ${path}\n${format === 'xlsx' ? '      sheets: [Revenue]\n' : ''}`;
          if (cache === 'cached') {
            writeFileSync(
              temp.path('lore.yaml'),
              `${base}build:\n  profile: permissive\n${required}`,
            );
            const permitted = JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout);
            expect(permitted.warnings).toBeGreaterThan(0);
            active = permitted.buildId;
          }
          writeFileSync(temp.path('lore.yaml'), `${base}build:\n  profile: strict\n${required}`);
          const before = JSON.parse((await cli(temp.root, ['--json', 'builds'])).stdout).builds;
          await expect(cli(temp.root, ['--json', 'build'])).rejects.toMatchObject({
            code: 2,
            stdout: expect.stringContaining('LORE_E_REQUIRED_COVERAGE'),
          });
          const builds = JSON.parse((await cli(temp.root, ['--json', 'builds'])).stdout);
          expect(builds.activeBuildId).toBe(active);
          expect(builds.builds).toEqual(before);
          expect((await cli(temp.root, ['inspect', 'warnings'])).stdout).toBeDefined();
        },
      );
    },
  );
}

it.each(['permissive', 'strict'] as const)(
  'handles an ignored required file under the %s profile',
  async (profile) => {
    const base = 'version: 1\nname: coverage\nsources: [docs]\n';
    await withTempProject(
      {
        files: {
          'lore.yaml': base,
          '.loreignore': 'required.md\n',
          'docs/notes.md': '# Retained\n',
          'docs/required.md': '# Excluded\n',
        },
      },
      async (temp) => {
        const first = JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout).buildId;
        writeFileSync(
          temp.path('lore.yaml'),
          `${base}build:\n  profile: ${profile}\n  required: [{path: docs/required.md}]\n`,
        );
        if (profile === 'strict') {
          await expect(cli(temp.root, ['--json', 'build'])).rejects.toMatchObject({
            code: 2,
            stdout: expect.stringContaining('LORE_E_REQUIRED_COVERAGE'),
          });
          expect(
            JSON.parse((await cli(temp.root, ['--json', 'builds'])).stdout).activeBuildId,
          ).toBe(first);
        } else {
          await cli(temp.root, ['--json', 'build']);
          const inspected = JSON.parse(
            (await cli(temp.root, ['--json', 'inspect', 'warnings'])).stdout,
          );
          expect(inspected.warnings).toContainEqual(
            expect.objectContaining({
              code: 'required-source-unavailable',
              path: 'docs/required.md',
            }),
          );
        }
      },
    );
  },
);

it('keeps strict build identity independent of root and declaration order, with readable config output', async () => {
  const ids: string[] = [];
  for (const reverse of [false, true]) {
    const paths = reverse ? ['docs/b.md', 'docs/a.md'] : ['docs/a.md', 'docs/b.md'];
    const config = [
      'version: 1',
      'name: coverage',
      'sources: [docs]',
      'build:',
      '  profile: strict',
      '  required:',
      ...paths.map((path) => `    - path: ${path}`),
      '',
    ].join('\n');
    const entries = [
      ['lore.yaml', config],
      ['docs/a.md', '# A\n\nFirst context.'],
      ['docs/b.md', '# B\n\nSecond context.'],
    ];
    if (reverse) entries.reverse();
    await withTempProject({ files: Object.fromEntries(entries) }, async (temp) => {
      ids.push(JSON.parse((await cli(temp.root, ['--json', 'build'])).stdout).buildId);
      const shown = (await cli(temp.root, ['config', 'show', '--effective'])).stdout;
      expect(shown).toContain('docs/a.md');
      expect(shown).toContain('docs/b.md');
      expect(shown).not.toContain('[object Object]');
      const explained = JSON.parse(
        (await cli(temp.root, ['--json', 'config', 'explain', 'build.profile'])).stdout,
      );
      expect(explained).toMatchObject({ value: 'strict', layer: 'project', buildId: true });
    });
  }
  expect(ids[0]).toBe(ids[1]);
});
