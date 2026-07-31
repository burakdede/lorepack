import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifactId,
  type BuildId,
  type BuildIdInputs,
  CANONICALIZATION_VERSION,
  deriveBuildId,
  hashBytes,
  hashRoot,
  NORMALIZATION_VERSION,
  toCanonical,
} from '@lorepack/core';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { createCandidateDirectory, sealCandidateDirectory } from '../src/atomic.js';
import { FileObjectStore } from '../src/object-store.js';
import { openWritable } from '../src/sqlite.js';
import { LocalActiveBuildProvider, LocalStateStore } from '../src/state-store.js';

/**
 * Phase 0 exit criterion, from the epic:
 *
 *   "a unit-level harness can create a build directory, write objects, compute a stable
 *    build ID, activate a pointer, and roll it back, with no user-facing CLI yet."
 *
 * This is that harness. It composes every Phase 0 primitive in the order the compiler
 * will use them, so the phase's claim is proven rather than asserted. It is not a
 * compiler: parsing, chunking and indexing arrive in Phase 1.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'migrations', 'local');

const SOURCES: Record<string, string> = {
  'docs/strategy.md': '# Strategy\n\nShip the lifecycle first.\n',
  'docs/pricing.md': '# Pricing\n\nOperator prices live in the workbook.\n',
};

interface MiniBuild {
  readonly buildId: BuildId;
  readonly artifactRoot: string;
  readonly objectRoot: string;
}

/**
 * Everything Phase 0 can do with a source tree: canonicalize paths, hash content, store
 * objects, and derive an identity from the result.
 */
async function compile(
  projectRoot: string,
  objects: FileObjectStore,
  order: readonly string[],
  sources: Record<string, string> = SOURCES,
): Promise<MiniBuild> {
  const artifactHashes: string[] = [];
  const objectHashes: string[] = [];

  for (const relativePath of order) {
    const contents = sources[relativePath] as string;
    const canonical = toCanonical(projectRoot, join(projectRoot, ...relativePath.split('/')));
    const contentHash = hashBytes(contents);
    const objectHash = await objects.put(new TextEncoder().encode(contents));

    objectHashes.push(objectHash);
    artifactHashes.push(hashBytes(`${artifactId('sources', canonical)}:${contentHash}`));
  }

  const inputs: BuildIdInputs = {
    formatVersion: 1,
    schemaVersion: 1,
    compilerVersion: '0.0.0-phase0',
    canonicalizationVersion: CANONICALIZATION_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    effectiveConfig: { name: 'phase-0', sources: ['.'] },
    parserVersions: {},
    ruleResolution: [],
    embeddingProfile: null,
    canonicalRoots: {
      artifacts: hashRoot(artifactHashes),
      nodes: hashRoot([]),
      chunks: hashRoot([]),
      tables: hashRoot([]),
      objects: hashRoot(objectHashes),
    },
  };

  return {
    buildId: deriveBuildId(inputs),
    artifactRoot: inputs.canonicalRoots.artifacts,
    objectRoot: inputs.canonicalRoots.objects,
  };
}

/** Seals a build directory and records it as verified, the way #30 will. */
function seal(loreDirectory: string, buildId: BuildId): void {
  const candidate = createCandidateDirectory(loreDirectory);
  writeFileSync(join(candidate.path, 'manifest.json'), JSON.stringify({ buildId }), 'utf8');
  const db = openWritable(join(candidate.path, 'context.sqlite'));
  db.exec('CREATE TABLE marker (build_id TEXT PRIMARY KEY) STRICT');
  db.prepare('INSERT INTO marker (build_id) VALUES (?)').run(buildId);
  db.close();
  sealCandidateDirectory(candidate, join(loreDirectory, 'builds', buildId));
}

describe('Phase 0 exit criterion', () => {
  it('builds, activates, serves, rebuilds, and rolls back', async () => {
    await withTempProject({ files: SOURCES }, async (project) => {
      const lore = project.path('.lore');
      const objects = new FileObjectStore(join(lore, 'objects'));
      const state = LocalStateStore.open(lore, MIGRATIONS);
      const provider = new LocalActiveBuildProvider(state, join(lore, 'builds'));

      try {
        // Build one.
        const first = await compile(project.root, objects, Object.keys(SOURCES));
        seal(lore, first.buildId);
        state.recordBuild({
          buildId: first.buildId,
          state: 'verified',
          createdAt: '2026-07-31T10:00:00Z',
          counts: { artifacts: 2, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
        });
        expect(state.activate(first.buildId)).toBe(1);
        expect(existsSync(join(lore, 'builds', first.buildId, 'context.sqlite'))).toBe(true);

        // Serve it: a handle reads the build the pointer names.
        const served = await provider.acquire();
        expect(served.buildId).toBe(first.buildId);
        expect(
          (
            provider.database(served).prepare('SELECT build_id FROM marker').get() as {
              build_id: string;
            }
          ).build_id,
        ).toBe(first.buildId);
        served.release();

        // Edit a source. A new build with a different identity follows.
        const edited = { ...SOURCES, 'docs/pricing.md': '# Pricing\n\nPrices changed.\n' };
        const second = await compile(project.root, objects, Object.keys(edited), edited);
        expect(second.buildId).not.toBe(first.buildId);
        expect(second.artifactRoot).not.toBe(first.artifactRoot);

        seal(lore, second.buildId);
        state.recordBuild({
          buildId: second.buildId,
          state: 'verified',
          createdAt: '2026-07-31T11:00:00Z',
          counts: { artifacts: 2, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
        });
        expect(state.activate(second.buildId)).toBe(2);

        // Both builds still exist: the first was not mutated by the second.
        expect(existsSync(join(lore, 'builds', first.buildId, 'manifest.json'))).toBe(true);

        // Roll back. No recompilation: only the pointer moves.
        expect(state.activate(first.buildId)).toBe(3);
        expect(state.current()).toEqual({ buildId: first.buildId, generation: 3 });

        const afterRollback = await provider.acquire();
        expect(afterRollback.buildId).toBe(first.buildId);
        afterRollback.release();
      } finally {
        provider.closeAll();
        state.close();
      }
    });
  });

  it('rolls back without touching the sources at all', async () => {
    await withTempProject({ files: SOURCES }, async (project) => {
      const lore = project.path('.lore');
      const objects = new FileObjectStore(join(lore, 'objects'));
      const state = LocalStateStore.open(lore, MIGRATIONS);

      try {
        const build = await compile(project.root, objects, Object.keys(SOURCES));
        seal(lore, build.buildId);
        state.recordBuild({
          buildId: build.buildId,
          state: 'verified',
          createdAt: '2026-07-31T10:00:00Z',
          counts: { artifacts: 2, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
        });
        state.activate(build.buildId);
        state.close();

        // Delete every source, then reopen and activate again. Rollback reads build data
        // only, so it must still work with no sources present.
        for (const relativePath of Object.keys(SOURCES)) {
          writeFileSync(project.path(relativePath), '');
        }
        const reopened = LocalStateStore.open(lore, MIGRATIONS);
        expect(reopened.activate(build.buildId)).toBe(2);
        expect(reopened.current()?.buildId).toBe(build.buildId);
        reopened.close();
      } catch (error) {
        state.close();
        throw error;
      }
    });
  });

  it('derives the same build id twice, from two absolute paths, in any enumeration order', async () => {
    const report = await checkDeterminism({
      files: SOURCES,
      produce: async (project, order) => {
        const objects = new FileObjectStore(project.path('.lore/objects'));
        const build = await compile(project.root, objects, order);
        return build.buildId;
      },
    });
    expect(report.message ?? '').toBe('');
    expect(report.deterministic).toBe(true);
  });

  it('produces an identical build id after the object store is deleted', async () => {
    await withTempProject({ files: SOURCES }, async (project) => {
      const order = Object.keys(SOURCES);
      const first = await compile(
        project.root,
        new FileObjectStore(project.path('.lore/objects')),
        order,
      );
      // A different object store entirely: identity comes from content, not from what
      // happens to be cached on disk.
      const second = await compile(
        project.root,
        new FileObjectStore(project.path('.lore/objects-2')),
        order,
      );
      expect(second.buildId).toBe(first.buildId);
    });
  });
});
