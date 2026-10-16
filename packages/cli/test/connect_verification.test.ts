import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, loadProjectConfig, ProgressBus, RUNTIME_LIMITS } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readConnectionExpectation } from '../src/services/connect_verification.js';

const CONFIG = 'version: 1\nname: expected\nsources: [docs]\n';

it('rejects an unbuilt project without creating a state store', async () => {
  await withTempProject(
    { files: { 'lore.yaml': CONFIG, 'docs/a.md': '# Not built\n' } },
    async (project) => {
      await expect(
        readConnectionExpectation(loadProjectConfig({ cwd: project.root })),
      ).rejects.toMatchObject({ code: 'LORE_E_BUILD_NOT_FOUND' });
      expect(existsSync(join(project.root, '.lore'))).toBe(false);
    },
  );
});

it('continues the pinned inventory beyond a full page of empty sources', async () => {
  const files: Record<string, string> = {
    'lore.yaml': CONFIG,
    'docs/zz.md': '# Known source\n\nReadable build content.\n',
  };
  for (let index = 0; index < 101; index += 1)
    files[`docs/empty_${String(index).padStart(3, '0')}.txt`] = '';
  await withTempProject({ files }, async (project) => {
    const config = loadConfig({ cwd: project.root });
    const built = await runBuild({ config, progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: project.root });
    try {
      const runtime = createRuntime(backend);
      const page = await runtime.listSources({ buildId: built.buildId, limit: 100 });
      expect(page.artifacts).toHaveLength(100);
      expect(page.nextOffset).toBe(100);
      const next = await runtime.listSources({ buildId: built.buildId, limit: 100, offset: 100 });
      const known = next.artifacts.find((artifact) => artifact.relativePath.endsWith('zz.md'));
      expect(known).toBeDefined();
      const expected = await readConnectionExpectation(config);
      expect(expected.buildId).toBe(built.buildId);
      expect(expected.request).toEqual({ buildId: built.buildId, artifactId: known?.artifactId });
      expect(expected.source.locator.relativePath).toBe(known?.relativePath);
      expect(expected.source.text).toContain('Readable build content.');
    } finally {
      backend.close();
    }
  });
}, 120_000);

it('reads the immutable expectation after the sources disappear', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': CONFIG,
        'docs/a.md': '# Retained\n\nStill readable without source files.\n',
      },
    },
    async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });
      const before = await readConnectionExpectation(config);
      rmSync(join(project.root, 'docs'), { recursive: true });
      expect(await readConnectionExpectation(config)).toEqual(before);
    },
  );
});

it('preserves the native source-read bound and its explicit truncation', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': CONFIG,
        'docs/large.txt': 'A'.repeat(RUNTIME_LIMITS.maxSourceReadCharacters + 100),
      },
    },
    async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });
      const expected = await readConnectionExpectation(config);
      expect(expected.source.text).toHaveLength(RUNTIME_LIMITS.maxSourceReadCharacters);
      expect(expected.source.truncated).toBe(true);
      expect(expected.source.buildId).toBe(expected.buildId);
    },
  );
}, 120_000);
