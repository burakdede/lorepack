import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifestSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

const CORPUS = {
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release.\n\n## Retention\n\nSix builds are kept.\n',
  'notes/meeting.txt': 'We discussed the deployment schedule.\n',
  // Two files that must show up as warnings rather than disappearing silently.
  'photo.png': 'not really an image',
  'report.pdf': '%PDF-1.4',
};

async function builtProject<T>(
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...CORPUS } }, async (temp) => {
    await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
    return body(temp.root, (args) => run(['--cwd', temp.root, ...args]));
  });
}

describe('lore inspect warnings', () => {
  it('lists every exclusion grouped by class, with exact paths', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'warnings']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('photo.png');
      expect(result.stdout).toContain('report.pdf');
      expect(result.stdout).toContain('unsupported-file');
    });
  });

  it('counts warnings by class as JSON', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'inspect', 'warnings'])).stdout);
      expect(parsed.total).toBeGreaterThanOrEqual(2);
      expect(Object.keys(parsed.byClass).length).toBeGreaterThan(0);
      expect(parsed.warnings.every((warning: { message: string }) => warning.message !== '')).toBe(
        true,
      );
    });
  });

  it('says so plainly when a build excluded nothing', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A\n\nText.' } },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        const result = await run(['--cwd', temp.root, 'inspect', 'warnings']);
        expect(result.stdout).toContain('No warnings');
      },
    );
  });
});

describe('lore inspect build', () => {
  it('shows counts, capabilities, versions and canonical roots', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'build']);

      expect(result.stdout).toContain('lexical-search');
      expect(result.stdout).toContain('canonical roots');
      expect(result.stdout).toMatch(/artifacts\s+[0-9a-f]{64}/);
      expect(result.stdout).toContain('(active)');
    });
  });

  it('emits the manifest itself as JSON', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'inspect', 'build'])).stdout);
      expect(buildManifestSchema.safeParse(parsed).success).toBe(true);
    });
  });
});

describe('lore inspect sources and artifacts', () => {
  it('lists every indexed artifact with its parser and chunk count', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'sources']);
      expect(result.stdout).toContain('guides/deployment.md');
      expect(result.stdout).toContain('notes/meeting.txt');
      expect(result.stdout).toContain('chunks');
    });
  });

  it('shows one artifact with its metadata and node outline', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'guides/deployment.md']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('markdown');
      expect(result.stdout).toContain('content hash');
      expect(result.stdout).toContain('structure');
      expect(result.stdout).toContain('Rollback');
    });
  });

  it('lists an artifact chunks with locators and token estimates', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'chunks', 'guides/deployment.md']);
      expect(result.stdout).toMatch(/guides\/deployment\.md:\d+-\d+/);
      expect(result.stdout).toContain('tokens');
    });
  });

  it('suggests near misses for a path that does not exist', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'deployment']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Did you mean');
      expect(result.stderr).toContain('guides/deployment.md');
    });
  });

  it('points at the source listing when nothing is close', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'nowhere/at/all.md']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore inspect sources');
    });
  });
});

describe('inspection reads only build data', () => {
  it('still works after every source file is deleted', async () => {
    // Section 4.9: what the compiler decided has to stay visible without re-running it.
    await builtProject(async (root, lore) => {
      rmSync(join(root, 'guides'), { recursive: true, force: true });
      rmSync(join(root, 'notes'), { recursive: true, force: true });
      rmSync(join(root, 'photo.png'));
      rmSync(join(root, 'report.pdf'));

      expect((await lore(['inspect', 'warnings'])).code).toBe(0);
      expect((await lore(['inspect', 'sources'])).stdout).toContain('guides/deployment.md');
      expect((await lore(['inspect', 'guides/deployment.md'])).code).toBe(0);
      expect((await lore(['inspect', 'build'])).code).toBe(0);
    });
  });

  it('can inspect a build that is not the active one', async () => {
    await builtProject(async (root, lore) => {
      const first = JSON.parse((await lore(['--json', 'inspect', 'build'])).stdout);
      rmSync(join(root, 'notes'), { recursive: true, force: true });
      await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });

      const older = JSON.parse(
        (await lore(['--json', 'inspect', 'build', '--build', first.buildId])).stdout,
      );
      expect(older.buildId).toBe(first.buildId);
      expect(older.counts.artifacts).toBeGreaterThan(0);
    });
  });

  it('fails with a typed error for an unknown build', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'build', '--build', 'lore_ffffffff']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
    });
  });
});
