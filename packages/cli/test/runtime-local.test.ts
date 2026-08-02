import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * The runtime over the real local ports, against a real build.
 *
 * `packages/runtime/test` exercises the runtime's own guarantees over fakes, which is the
 * right level for handle lifecycle and envelope stamping. It cannot see anything about
 * SQLite, and the first thing this file caught was exactly that: `describeBuild` counts
 * warnings, `build_warnings` was outside the authorizer's allowlist, and every fake in the
 * world would have gone on passing.
 *
 * This lives in the CLI package because that is where a build can be produced. The
 * implementation-agnostic version of these assertions arrives with the contract suite (#52).
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release without recompiling.\n',
  'guides/onboarding.md': '# Onboarding\n\nNew engineers configure their laptop on day one.\n',
  'notes/standup.txt': 'Discussed the deployment schedule and rollback safety.\n',
  // Never parsed, so the build carries a warning and `describeBuild` has one to count.
  'diagram.png': 'not really an image',
};

async function withRuntime<T>(
  body: (runtime: ReturnType<typeof createRuntime>, root: string) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: CORPUS }, async (project) => {
    await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: project.root });
    try {
      return await body(createRuntime(backend), project.root);
    } finally {
      backend.close();
    }
  });
}

describe('describeBuild over the local ports', () => {
  it('reads the manifest, the counts and the warnings the build actually holds', async () => {
    await withRuntime(async (runtime) => {
      const described = await runtime.describeBuild();

      expect(described.projectName).toBe('demo');
      expect(described.counts.artifacts).toBe(3);
      expect(described.counts.chunks).toBeGreaterThan(0);
      // The authorizer has to permit `build_warnings`, and only a real database says so.
      expect(described.warningCount).toBe(1);
      expect(described.capabilities).toContain('lexical-search');
      expect(described.compilerVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(described.sourceState).toBe('unknown');
    });
  });
});

describe('search over the local ports', () => {
  it('answers with provenance, and permits the pragma FTS5 reads internally', async () => {
    await withRuntime(async (runtime) => {
      const result = await runtime.search({
        query: 'rollback',
        limit: 10,
        includeArchived: false,
        debug: false,
      });

      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.totalIndexedChunks).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.locator.relativePath).not.toBe('');
        expect(hit.locator.artifactId).toBe(hit.artifactId);
      }
    });
  });

  it('narrows by path and by extension through the ports, not in the caller', async () => {
    await withRuntime(async (runtime) => {
      const scoped = await runtime.search({
        query: 'rollback',
        limit: 10,
        includeArchived: false,
        debug: false,
        pathGlob: 'notes/*',
      });
      const typed = await runtime.search({
        query: 'rollback',
        limit: 10,
        includeArchived: false,
        debug: false,
        fileType: 'md',
      });

      expect(scoped.hits.every((hit) => hit.locator.relativePath.startsWith('notes/'))).toBe(true);
      expect(typed.hits.every((hit) => hit.locator.relativePath.endsWith('.md'))).toBe(true);
      expect(typed.hits.length).toBeGreaterThan(0);
    });
  });

  it('refuses to read a table outside the runtime surface, whatever the query asks for', async () => {
    await withRuntime(async (_runtime, root) => {
      const backend = createLocalRuntimeBackend({ projectRoot: root });
      try {
        const handle = await backend.provider.acquire();
        try {
          await backend.open(handle);
          const db = (
            backend.provider as { database(h: unknown): { prepare(sql: string): unknown } }
          ).database(handle);
          // `schema_migrations` exists in the build database and is not part of the read
          // surface. The authorizer, not the query author, is what stops this.
          expect(() => db.prepare('SELECT * FROM schema_migrations')).toThrow();
        } finally {
          handle.release();
        }
      } finally {
        backend.close();
      }
    });
  });
});

describe('the handle, against a real provider', () => {
  it('leaves nothing open once the backend is closed', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      const runtime = createRuntime(backend);

      await runtime.describeBuild();
      await runtime.search({ query: 'rollback', limit: 3, includeArchived: false, debug: false });

      const provider = backend.provider as unknown as { openBuildCount: number };
      expect(provider.openBuildCount).toBe(1);
      backend.close();
      expect(provider.openBuildCount).toBe(0);
    });
  });

  it('serves the build that was active when the call started, after a rebuild', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: project.root });
      const runtime = createRuntime(backend);

      expect((await runtime.describeBuild()).buildId).toBe(first.buildId);

      writeFileSync(
        join(project.root, 'guides', 'onboarding.md'),
        '# Onboarding\n\nNow with a buddy scheme.\n',
        'utf8',
      );
      const second = await runBuild({ config, progress: new ProgressBus() });
      expect(second.buildId).not.toBe(first.buildId);

      // No client action, no restart: the next request observes the new generation.
      expect((await runtime.describeBuild()).buildId).toBe(second.buildId);
      backend.close();
    });
  });
});
