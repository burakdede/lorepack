import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it, vi } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';

const corruption = vi.hoisted(() => ({ kind: 'none' as 'none' | 'table' | 'locator' }));
vi.mock('@lorepack/backend-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorepack/backend-local')>();
  return {
    ...actual,
    writeCatalog: (options: Parameters<typeof actual.writeCatalog>[0]) => {
      const counts = actual.writeCatalog(options);
      if (corruption.kind === 'table') options.db.exec('UPDATE tables SET row_count=99');
      if (corruption.kind === 'locator')
        options.db.exec("UPDATE nodes SET line_end=100000 WHERE kind='paragraph'");
      return counts;
    },
  };
});

it.each(['table', 'locator'] as const)(
  'rejects a stored candidate %s corruption before sealing or activation, issue415',
  async (kind) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: candidate\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nOriginal A.\n',
          'docs/data.csv': 'id,value\n00017,120000\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        await runBuild({ config, progress: new ProgressBus() });
        const lore = join(project.root, '.lore');
        const active = readActiveBuild(lore);
        const builds = readdirSync(join(lore, 'builds'));
        writeFileSync(join(project.root, 'docs/policy.md'), '# Policy\n\nChanged B.\n');
        corruption.kind = kind;
        try {
          await expect(runBuild({ config, progress: new ProgressBus() })).rejects.toMatchObject({
            code: 'LORE_E_BUILD_VALIDATION',
            details: {
              failures: expect.arrayContaining([
                {
                  check: kind === 'table' ? 'table-mapping' : 'locator-ranges',
                  message: expect.any(String),
                  subject: expect.any(String),
                },
              ]),
            },
          });
          expect(readActiveBuild(lore)).toEqual(active);
          expect(readdirSync(join(lore, 'builds'))).toEqual(builds);
        } finally {
          corruption.kind = 'none';
        }
      },
    );
  },
);
