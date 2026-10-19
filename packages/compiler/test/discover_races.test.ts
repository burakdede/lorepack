import { readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discover } from '../src/discover/discover.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

afterEach(() => {
  vi.mocked(readdirSync).mockImplementation(realFs.readdirSync);
  vi.mocked(realpathSync).mockImplementation(realFs.realpathSync);
});

const CONFIG = 'version: 1\nname: Race Fixture\nsources:\n  - .\n';

describe('discovery races use actual filesystem failures', () => {
  it('reports a child deleted after directory enumeration before inspecting its entry', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'gone.md': '# Gone', 'keep.md': '# Keep' } },
      (project) => {
        const config = loadConfig({ cwd: project.root });
        vi.mocked(readdirSync).mockImplementation((path, options) => {
          const entries = realFs.readdirSync(path, options);
          if (String(path) === project.root) rmSync(project.path('gone.md'));
          return entries;
        });
        const result = discover({ config });
        expect(result.artifacts.map((item) => item.relativePath)).toEqual(['keep.md']);
        expect(result.warnings).toContainEqual({
          code: 'unreadable',
          path: 'gone.md',
          message: 'gone.md could not be read.',
        });
      },
    );
  });

  it.each([false, true])(
    'reports a resolved symlink whose target disappears, root removed: %s',
    async (removeRoot) => {
      await withTempProject(
        { files: { 'lore.yaml': CONFIG, 'z-target.md': '# Target' } },
        (project) => {
          const root = realFs.realpathSync(project.root);
          const link = join(root, 'a-link.md');
          symlinkSync(join(root, 'z-target.md'), link);
          const loaded = loadConfig({ cwd: root });
          const config = { ...loaded, effective: { ...loaded.effective, followSymlinks: true } };
          vi.mocked(realpathSync).mockImplementation((path, options) => {
            const resolved = realFs.realpathSync(path, options);
            if (String(path) === link) {
              if (removeRoot) rmSync(root, { recursive: true });
              else rmSync(join(root, 'z-target.md'));
            }
            return resolved;
          });
          const result = discover({ config });
          expect(result.artifacts).toEqual([]);
          expect(result.warnings).toContainEqual({
            code: 'unreadable',
            path: 'a-link.md',
            message: 'a-link.md could not be read.',
          });
          expect(result.warnings).toContainEqual({
            code: 'unreadable',
            path: 'z-target.md',
            message: 'z-target.md could not be read.',
          });
        },
      );
    },
  );
});
