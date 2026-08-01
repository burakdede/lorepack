import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoreError, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { degradedFreshness, readFreshness } from '../src/services/status.js';
import { run } from './helpers.js';

/**
 * The regression tests for #147.
 *
 * Freshness is an annotation on an answer, not a precondition for producing one. These pin
 * the two halves of that: it reports honestly when it can, and it degrades to `unknown`
 * rather than failing the command when it cannot.
 */

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';
const SOURCES = {
  'lore.yaml': CONFIG,
  'a.md': '# A\n\nRollback restores the previous release.\n',
  'b.md': '# B\n\nMore text.\n',
};

describe('readFreshness', () => {
  it('reports clean sources with no reason attached', async () => {
    await withTempProject({ files: SOURCES }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      expect(await readFreshness({ config })).toEqual({ sourceState: 'clean', reason: null });
    });
  });

  it('reports dirty sources with no reason attached', async () => {
    await withTempProject({ files: SOURCES }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });
      project.write('a.md', '# A\n\nEdited.\n');

      expect(await readFreshness({ config })).toEqual({ sourceState: 'dirty', reason: null });
    });
  });

  it('calls an unbuilt project unknown rather than clean', async () => {
    // Invariant 6: `unknown` says Lorepack does not know. Reporting `clean` here would be
    // claiming the sources match a build that does not exist.
    await withTempProject({ files: SOURCES }, async (project) => {
      const freshness = await readFreshness({ config: loadConfig({ cwd: project.root }) });
      expect(freshness.sourceState).toBe('unknown');
    });
  });

  it('reports a project whose sources have vanished, rather than failing the caller', async () => {
    // Discovery reports a missing or escaping source root as a warning rather than an
    // exception, so this lands on the ordinary path: zero artifacts against a build that
    // had some, which is dirty. The command still answers, which is the point.
    await withTempProject({ files: SOURCES }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });
      rmSync(join(project.root, 'a.md'));
      rmSync(join(project.root, 'b.md'));

      const freshness = await readFreshness({ config });
      expect(freshness.sourceState).toBe('dirty');
      expect(freshness.reason).toBeNull();
    });
  });

  it('never applies the file envelope, because that guard is about building', async () => {
    // #147: `lore search` refused to answer on a project above the envelope, even though
    // the build it would have read was already sealed on disk.
    const many = Object.fromEntries(
      Array.from({ length: 2501 }, (_, index) => [`docs/doc-${index}.md`, `# Doc ${index}\n`]),
    );

    await withTempProject({ files: { 'lore.yaml': CONFIG, ...many } }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus(), allowLargeProject: true });

      const freshness = await readFreshness({ config });
      expect(freshness.sourceState).toBe('clean');
      expect(freshness.reason).toBeNull();
    });
  });
});

describe('degradedFreshness', () => {
  // The decision the catch in `readFreshness` makes, tested where it can be seen. A bare
  // catch would turn a corrupt state database into a cheerful, false "freshness unknown",
  // and hide a real defect for a phase or two.
  it.each([
    ['LORE_E_ENVELOPE_EXCEEDED', 'the project is above the file envelope'],
    ['LORE_E_PATH_ESCAPE', 'a path resolved outside its source root'],
    ['LORE_E_CASE_COLLISION', 'two paths differ only by case'],
  ] as const)('degrades %s, because it is about the source tree', (code, message) => {
    const degraded = degradedFreshness(new LoreError(code, message));
    expect(degraded).toEqual({ sourceState: 'unknown', reason: message });
  });

  it.each(['LORE_E_INTERNAL', 'LORE_E_OBJECT_CORRUPT', 'LORE_E_BUILD_VALIDATION'] as const)(
    'refuses to swallow %s, because it says nothing about the sources',
    (code) => {
      expect(degradedFreshness(new LoreError(code, 'something is wrong'))).toBeNull();
    },
  );

  it('refuses to swallow an error that is not ours at all', () => {
    expect(degradedFreshness(new TypeError('undefined is not a function'))).toBeNull();
  });
});

describe('lore search above the envelope', () => {
  it('answers from the build instead of refusing', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 2501 }, (_, index) => [
        `docs/doc-${index}.md`,
        `# Doc ${index}\n\nRollback restores the previous release.\n`,
      ]),
    );

    await withTempProject({ files: { 'lore.yaml': CONFIG, ...many } }, async (project) => {
      await runBuild({
        config: loadConfig({ cwd: project.root }),
        progress: new ProgressBus(),
        allowLargeProject: true,
      });

      const result = await run(['--cwd', project.root, '--json', 'search', 'rollback']);
      expect(result.code, result.stderr).toBe(0);

      const parsed = JSON.parse(result.stdout) as {
        sourceState: string;
        hits: Array<{ locator: { relativePath: string } }>;
      };
      expect(parsed.sourceState).toBe('clean');
      expect(parsed.hits[0]?.locator.relativePath).toMatch(/^docs\/doc-\d+\.md$/);
    });
  });
});
