import { loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { closestPath, displayValue, resolveConfiguration } from '../src/services/config-resolve.js';

/**
 * The transparent-magic contract (architecture 4.9): defaults work, and nothing is hidden.
 *
 * The test of it is not that values are correct, it is that a user can find out where each
 * one came from without reading the source. So most of what is asserted here is provenance,
 * and the one thing asserted hardest is the line between what participates in the build id
 * and what does not, because getting that wrong is expensive in both directions.
 */

const MINIMAL = {
  'lore.yaml': 'version: 1\nname: layered\nsources:\n  - .\n',
  'a.md': '# A\n\nOne.\n',
};

describe('where a value came from', () => {
  it('attributes an untouched value to the built-in defaults', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const resolved = resolveConfiguration(loadConfig({ cwd: project.root }), {});
      const chunking = resolved.values.find((entry) => entry.path === 'chunking.targetTokens');

      expect(chunking?.layer).toBe('defaults');
      expect(chunking?.source).toBe('built-in');
    });
  });

  it('attributes a value the project file sets to the project file', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const resolved = resolveConfiguration(loadConfig({ cwd: project.root }), {});
      const name = resolved.values.find((entry) => entry.path === 'name');

      expect(name?.layer).toBe('project');
      expect(name?.source).toContain('lore.yaml');
      expect(name?.value).toBe('layered');
    });
  });

  it('lets the environment layer override the layers below it', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const config = loadConfig({ cwd: project.root });

      const withoutEnvironment = resolveConfiguration(config, {});
      expect(
        withoutEnvironment.values.find((entry) => entry.path === 'runtime.devPort')?.layer,
      ).toBe('defaults');

      // Architecture 6.8: environment sits above defaults, the project file and targets.
      const withEnvironment = resolveConfiguration(config, { LORE_DEV_PORT: '45000' });
      const port = withEnvironment.values.find((entry) => entry.path === 'runtime.devPort');

      expect(port?.layer).toBe('environment');
      expect(port?.source).toBe('LORE_DEV_PORT');
      expect(port?.value).toBe(45_000);
    });
  });
});

describe('what the build id is computed from', () => {
  it('marks every value in the hashed effective configuration', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const resolved = resolveConfiguration(loadConfig({ cwd: project.root }), {});

      for (const path of ['include', 'exclude', 'chunking.targetTokens', 'limits.maxChunks']) {
        expect(
          resolved.values.find((entry) => entry.path === path)?.buildId,
          `${path} decides what a build contains`,
        ).toBe(true);
      }
    });
  });

  /**
   * The Phase 3 audit on #4 called this out specifically, and it is the assertion most worth
   * having: folding a serving bound into the hashed structure would change the identity of
   * every build in existence for a number that decides nothing about what any of them hold.
   */
  it('marks serving bounds as outside it, while still showing them', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const resolved = resolveConfiguration(loadConfig({ cwd: project.root }), {});

      for (const path of [
        'runtime.devPort',
        'runtime.revalidateIntervalMs',
        'runtime.maxSourceReadCharacters',
      ]) {
        const entry = resolved.values.find((candidate) => candidate.path === path);
        expect(entry, `${path} should be shown`).toBeDefined();
        expect(entry?.buildId, `${path} must not change the build id`).toBe(false);
      }
    });
  });

  it('agrees with the hashing module about which values it hashes', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const resolved = resolveConfiguration(config, {});

      // The guard against drift between the resolver and architecture 11.4: every top-level
      // key of the hashed structure has to appear as a marked value, or `show --effective`
      // is telling the user about a different configuration from the one being hashed.
      const marked = new Set(
        resolved.values.filter((entry) => entry.buildId).map((entry) => entry.path.split('.')[0]),
      );
      for (const key of Object.keys(config.effective)) {
        if (key === 'version') continue;
        expect(marked.has(key), `${key} is hashed but not marked in the resolver`).toBe(true);
      }
    });
  });
});

describe('secrets', () => {
  it('never prints a value whose name looks like a credential', async () => {
    await withTempProject({ files: MINIMAL }, async (project) => {
      const resolved = resolveConfiguration(loadConfig({ cwd: project.root }), {});
      const secret = { ...resolved.values[0], secret: true, value: 'hunter2' } as const;

      // A guardrail on the rendering, so a secret cannot reach output by being added to a
      // layer later without anyone revisiting the renderer.
      expect(displayValue(secret)).toBe('[redacted]');
      expect(displayValue(secret)).not.toContain('hunter2');
    });
  });
});

describe('a path that does not exist', () => {
  it('suggests the one that probably was meant', () => {
    const known = ['chunking.targetTokens', 'limits.maxChunks', 'runtime.devPort'];
    expect(closestPath('chunking.targetToken', known)).toBe('chunking.targetTokens');
    expect(closestPath('limits.maxChunk', known)).toBe('limits.maxChunks');
  });

  it('suggests nothing when nothing is close, rather than something wrong', () => {
    // A confident wrong suggestion sends the reader to change something they never meant to
    // touch, which is worse than saying nothing.
    expect(closestPath('completely.unrelated.nonsense', ['a', 'b'])).toBeNull();
  });
});
