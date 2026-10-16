import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { readActiveBuild } from '../src/services/project.js';

const execute = promisify(execFile);
const binary = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const config = 'version: 1\nname: bounded-patterns\nsources: [.]\n';
const repeated = 'a*a*a*a*a*a*a*a*a*a*a*a*a*z';

function cli(root: string, args: readonly string[]) {
  return execute(process.execPath, [binary, '--json', ...args], {
    cwd: root,
    timeout: 30_000,
  });
}

it.each(['ignore', 'match', 'supersedes'] as const)(
  'rejects invalid %s input through plan/build/dev without changing the selected build',
  async (kind) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': config,
          'a.md': '# Public\n\nNarwhal remains available.\n',
          [`${'a'.repeat(34)}.md`]: '# Long filename\n\nExisting source.\n',
        },
      },
      async ({ root }) => {
        const before = JSON.parse((await cli(root, ['build'])).stdout) as { buildId: string };
        const lore = join(root, '.lore');
        const manifest = join(lore, 'builds', before.buildId, 'manifest.json');
        const bytes = readFileSync(manifest);
        const builds = readdirSync(join(lore, 'builds'));
        if (kind === 'ignore') writeFileSync(join(root, '.loreignore'), `# note\n\n${repeated}\n`);
        else
          writeFileSync(
            join(root, 'lore.yaml'),
            config +
              (kind === 'match'
                ? `rules:\n  - match: '${repeated}'\n    authority: 80\n`
                : `rules:\n  - match: '*.md'\n    supersedes: ['${repeated}']\n`),
          );
        for (const command of ['plan', 'build', 'dev']) {
          const failure: unknown = await cli(root, [command]).then(
            () => null,
            (error: unknown) => error,
          );
          expect(failure, command).toMatchObject({
            code: 1,
            stdout: expect.stringContaining('LORE_E_CONFIG_INVALID'),
          });
          expect(failure, command).toMatchObject({
            stdout: expect.stringContaining(kind === 'ignore' ? 'line 3' : 'rules.0.'),
          });
          expect(readActiveBuild(lore)?.buildId).toBe(before.buildId);
          expect(readFileSync(manifest)).toEqual(bytes);
          expect(readdirSync(join(lore, 'builds'))).toEqual(builds);
        }
        if (kind === 'ignore') {
          const retained = JSON.parse((await cli(root, ['inspect', 'build'])).stdout) as {
            buildId: string;
          };
          expect(retained.buildId).toBe(before.buildId);
          writeFileSync(join(root, '.loreignore'), '');
        } else writeFileSync(join(root, 'lore.yaml'), config);
        const result = JSON.parse((await cli(root, ['search', 'narwhal'])).stdout) as {
          buildId: string;
          hits: unknown[];
        };
        expect(result.buildId).toBe(before.buildId);
        expect(result.hits.length).toBeGreaterThan(0);
      },
    );
  },
  180_000,
);
