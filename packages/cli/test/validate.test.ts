import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { makePdf, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readActiveBuild } from '../src/services/project.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

describe('lorepack validate', () => {
  it('validates a changed candidate without activating it', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'notes.md': '# First\n\nOriginal context.\n' } },
      async (temp) => {
        const config = loadConfig({ cwd: temp.root });
        const first = await runBuild({ config, progress: new ProgressBus() });
        writeFileSync(join(temp.root, 'notes.md'), '# First\n\nChanged context.\n', 'utf8');

        const result = await run(['--cwd', temp.root, 'validate']);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Validated lore_');
        expect(result.stdout).toContain('active build was not changed');
        expect(readActiveBuild(join(temp.root, '.lore'))?.buildId).toBe(first.buildId);
      },
    );
  });

  it('emits only the candidate result as JSON and leaves progress on stderr', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'notes.md': '# Notes\n\nContext.\n' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, '--json', 'validate']);
        const parsed = JSON.parse(result.stdout) as {
          buildId: string;
          activated: boolean;
          created: boolean;
        };

        expect(result.code).toBe(0);
        expect(parsed.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
        expect(parsed.created).toBe(true);
        expect(parsed.activated).toBe(false);
        expect(result.stdout).not.toContain('Parsing');
        expect(result.stderr).toContain('Parsing');
      },
    );
  });

  it('refuses a fully scanned PDF and keeps the active build unchanged', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'notes.md': '# Notes\n\nExisting context.\n' } },
      async (temp) => {
        const config = loadConfig({ cwd: temp.root });
        const first = await runBuild({ config, progress: new ProgressBus() });
        writeFileSync(
          join(temp.root, 'scanned.pdf'),
          makePdf([
            { lines: [], image: true },
            { lines: [], image: true },
          ]),
        );

        const result = await run(['--cwd', temp.root, 'validate']);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('LORE_E_UNSUPPORTED_FORMAT');
        expect(result.stderr).toContain('Optical character recognition is out of scope');
        expect(readActiveBuild(join(temp.root, '.lore'))?.buildId).toBe(first.buildId);
      },
    );
  });
});
