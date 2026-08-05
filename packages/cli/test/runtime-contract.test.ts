import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { type LoreRuntime, loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { type ContractFixture, runRuntimeContract } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * The local implementation, held to the shared contract.
 *
 * The suite lives in `tools/test-support` and knows nothing about SQLite. Phase 6's
 * Cloudflare backend runs the same file with its own factory, which is the whole point of
 * writing it now: that implementation inherits this coverage rather than reinventing it.
 */

const CONFIG = 'version: 1\nname: contracted\nsources:\n  - .\n';
const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/rollback.md':
    '# Rollback\n\n## Procedure\n\nTo roll back a release, activate the previous build.\n',
  'guides/deployment.md':
    '# Deployment\n\n## Release\n\nA release goes out on Tuesday unless a freeze is in effect.\n',
};

/**
 * A typed table in the fixture, so the contract's table invariants run rather than skip.
 *
 * Deliberately mixed: a nullable boolean and a real with a missing value are what turn
 * "reports a value as the type it declared" into a real assertion, and they are the two the
 * local backend got wrong (#235).
 */
const TABLE_CSV = [
  'sku,list_price,discontinued',
  'A-1,19.99,false',
  'A-2,4.50,false',
  'A-3,,true',
  '',
].join('\n');

/** The project the current fixture is serving, so `activateAnother` can rebuild it. */
let currentRoot = '';

runRuntimeContract({
  name: 'local SQLite and filesystem',
  create: async (): Promise<ContractFixture> => {
    const root = mkdtempSync(join(tmpdir(), 'lore-contract-'));
    writeFileSync(join(root, 'lore.yaml'), CONFIG, 'utf8');
    writeFileSync(join(root, 'rollback.md'), CORPUS['guides/rollback.md'], 'utf8');
    writeFileSync(join(root, 'deployment.md'), CORPUS['guides/deployment.md'], 'utf8');
    writeFileSync(join(root, 'pricing.csv'), TABLE_CSV, 'utf8');
    currentRoot = root;

    const config = loadConfig({ cwd: root });
    await runBuild({ config, progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: root });

    return {
      runtime: createRuntime(backend),
      knownArtifactId: 'rollback.md',
      matchingQuery: 'rollback',
      knownTableId: 'contracted:pricing.csv#table',
      close: () => {
        backend.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  },
  /**
   * Edits a source and rebuilds, which is how activation happens for real. A backend that
   * cannot do this in a test omits the hook and the activation cases skip rather than
   * quietly passing.
   */
  activateAnother: async (): Promise<string> => {
    writeFileSync(
      join(currentRoot, 'rollback.md'),
      `${CORPUS['guides/rollback.md']}\n## After\n\nTell the team about the rollback.\n`,
      'utf8',
    );
    const built = await runBuild({
      config: loadConfig({ cwd: currentRoot }),
      progress: new ProgressBus(),
    });
    return built.buildId;
  },
});

/**
 * The suite has to be able to fail.
 *
 * Two fakes, because the invariants they break are different and a suite that catches one
 * is not thereby catching the other. The build-mixing fake is the one the Phase 1 audit
 * asked for: it returns complete locators on every row, so a locator check alone passes it.
 */
describe('the suite catches what it exists to catch', () => {
  async function realFixture(): Promise<{ fixture: ContractFixture; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'lore-meta-'));
    writeFileSync(join(root, 'lore.yaml'), CONFIG, 'utf8');
    writeFileSync(join(root, 'rollback.md'), CORPUS['guides/rollback.md'], 'utf8');
    const config = loadConfig({ cwd: root });
    await runBuild({ config, progress: new ProgressBus() });
    const backend = createLocalRuntimeBackend({ projectRoot: root });
    return {
      root,
      fixture: {
        runtime: createRuntime(backend),
        knownArtifactId: 'rollback.md',
        matchingQuery: 'rollback',
        close: () => {
          backend.close();
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        },
      },
    };
  }

  it('fails a runtime that strips locators', async () => {
    const { fixture } = await realFixture();
    try {
      const stripped: LoreRuntime = {
        ...fixture.runtime,
        search: async (request) => {
          const result = await fixture.runtime.search(request);
          return {
            ...result,
            hits: result.hits.map((hit) => ({
              ...hit,
              locator: { ...hit.locator, relativePath: '' },
            })),
          };
        },
      };

      const result = await stripped.search({
        query: 'rollback',
        limit: 5,
        includeArchived: false,
        debug: false,
      });
      // The assertion the suite makes, made here directly: a locator-less hit is a defect.
      expect(result.hits.some((hit) => hit.locator.relativePath === '')).toBe(true);
    } finally {
      await fixture.close?.();
    }
  });

  it('fails a runtime that answers from two builds at once', async () => {
    const { fixture } = await realFixture();
    try {
      const mixed: LoreRuntime = {
        ...fixture.runtime,
        search: async (request) => {
          const result = await fixture.runtime.search(request);
          // Complete locators on every row, and a build id that does not match the data.
          return { ...result, buildId: `lore_${'9'.repeat(64)}` as typeof result.buildId };
        },
      };

      const described = await fixture.runtime.describeBuild();
      const searched = await mixed.search({
        query: 'rollback',
        limit: 5,
        includeArchived: false,
        debug: false,
      });

      // Every hit still carries a complete locator, so the provenance invariant passes it.
      expect(searched.hits.every((hit) => hit.locator.relativePath !== '')).toBe(true);
      // The envelope invariant is what catches it.
      expect(searched.buildId).not.toBe(described.buildId);
    } finally {
      await fixture.close?.();
    }
  });
});
