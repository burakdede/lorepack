import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildId, LoreError, loadConfig, planSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import {
  assertNoDrift,
  buildLockfile,
  compareLockfiles,
  readLockfile,
  writeLockfile,
} from '../src/lock/lockfile.js';
import { createPlan, type PreviousBuild, renderPlan } from '../src/plan/plan.js';

const CONFIG = 'version: 1\nname: p\nsources:\n  - .\n';
const BUILD_ID = `lore_${'a'.repeat(64)}` as BuildId;

const LOCK_INPUTS = {
  compilerVersion: '0.1.0',
  schemaVersion: 1,
  parserVersions: { markdown: '0.1.0', text: '0.1.0' },
};

async function planIn(
  root: string,
  previous: PreviousBuild | null = null,
  previousLock = buildLockfile(LOCK_INPUTS),
) {
  return createPlan({
    config: loadConfig({ cwd: root }),
    previous,
    previousLock,
    lockInputs: LOCK_INPUTS,
    now: () => new Date('2026-08-01T00:00:00Z'),
  });
}

describe('lockfile', () => {
  it('records the versions that can change build output, with parsers sorted', () => {
    const lock = buildLockfile({
      compilerVersion: '0.1.0',
      schemaVersion: 1,
      parserVersions: { text: '0.1.0', markdown: '0.1.0' },
    });
    expect(Object.keys(lock.parsers)).toEqual(['markdown', 'text']);
    expect(lock.semantic).toBeNull();
  });

  it('round-trips through the filesystem', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, (project) => {
      const lock = buildLockfile(LOCK_INPUTS);
      writeLockfile(project.root, lock);
      expect(readLockfile(project.root)).toEqual(lock);
    });
  });

  it('returns null when there is no lockfile yet', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG } }, (project) => {
      expect(readLockfile(project.root)).toBeNull();
    });
  });

  it('rejects a malformed lockfile with a way out', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'lore.lock': 'compiler: [\n' } },
      (project) => {
        try {
          readLockfile(project.root);
          expect.unreachable('should have thrown');
        } catch (error) {
          expect((error as LoreError).remediation).toContain('Delete');
        }
      },
    );
  });

  it('rejects a lockfile missing a required field', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'lore.lock': 'formatVersion: 1\ncompiler: 0.1.0\n' } },
      (project) => {
        expect(() => readLockfile(project.root)).toThrowError(LoreError);
      },
    );
  });
});

describe('lock drift', () => {
  const base = buildLockfile(LOCK_INPUTS);

  it('reports no change for an identical lockfile', () => {
    expect(compareLockfiles(base, buildLockfile(LOCK_INPUTS)).changed).toBe(false);
  });

  it('treats a missing lockfile as a change, since one will be created', () => {
    expect(compareLockfiles(null, base).changed).toBe(true);
  });

  it.each([
    ['compiler', { ...LOCK_INPUTS, compilerVersion: '0.2.0' }, 'compiler'],
    ['schema', { ...LOCK_INPUTS, schemaVersion: 2 }, 'schema'],
    [
      'a parser',
      { ...LOCK_INPUTS, parserVersions: { markdown: '0.2.0', text: '0.1.0' } },
      'parsers.markdown',
    ],
  ])('detects a %s change and names the key', (_label, inputs, key) => {
    const drift = compareLockfiles(base, buildLockfile(inputs));
    expect(drift.changed).toBe(true);
    expect(drift.changes.map((change) => change.key)).toContain(key);
  });

  it('detects a newly added parser', () => {
    const drift = compareLockfiles(
      base,
      buildLockfile({
        ...LOCK_INPUTS,
        parserVersions: { ...LOCK_INPUTS.parserVersions, pdf: '0.1.0' },
      }),
    );
    expect(drift.changes[0]?.key).toBe('parsers.pdf');
    expect(drift.changes[0]?.from).toBeNull();
  });

  it('fails --frozen with the exact diff rather than a generic mismatch', () => {
    const drift = compareLockfiles(
      base,
      buildLockfile({ ...LOCK_INPUTS, compilerVersion: '0.2.0' }),
    );
    try {
      assertNoDrift(drift);
      expect.unreachable('should have thrown');
    } catch (error) {
      const loreError = error as LoreError;
      expect(loreError.code).toBe('LORE_E_LOCKFILE_DRIFT');
      expect(loreError.message).toContain('compiler: 0.1.0 -> 0.2.0');
      expect(loreError.remediation).toContain('without --frozen');
    }
  });

  it('passes --frozen when nothing drifted', () => {
    expect(() => assertNoDrift({ changed: false, changes: [] })).not.toThrow();
  });
});

describe('plan', () => {
  it('reports a first build as everything added', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'b.md': '# B' } },
      async (project) => {
        const { plan } = await planIn(project.root);
        expect(plan.activeBuildId).toBeNull();
        expect(plan.sourceState).toBe('unknown');
        expect(plan.artifacts.added).toBe(2);
        expect(plan.artifacts.reused).toBe(0);
      },
    );
  });

  it('reports a clean project when nothing changed', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const first = await planIn(project.root);
      const previous: PreviousBuild = {
        buildId: BUILD_ID,
        artifactHashes: new Map(
          first.fingerprint.artifacts.map((artifact) => [
            artifact.artifactId,
            artifact.contentHash,
          ]),
        ),
        chunkCount: 4,
        capabilities: ['lexical-search'],
      };
      const { plan } = await planIn(project.root, previous);

      expect(plan.sourceState).toBe('clean');
      expect(plan.artifacts).toMatchObject({ added: 0, changed: 0, removed: 0 });
      expect(plan.expectedWork.parseArtifacts).toBe(0);
    });
  });

  it('separates added, changed and removed with their paths', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'keep.md': '# Keep', 'edit.md': '# Before' } },
      async (project) => {
        const first = await planIn(project.root);
        const hashes = new Map(
          first.fingerprint.artifacts.map((artifact) => [
            artifact.artifactId,
            artifact.contentHash,
          ]),
        );
        hashes.set('p:gone.md', 'f'.repeat(64));

        writeFileSync(project.path('edit.md'), '# After', 'utf8');
        writeFileSync(project.path('new.md'), '# New', 'utf8');

        const { plan } = await planIn(project.root, {
          buildId: BUILD_ID,
          artifactHashes: hashes,
          chunkCount: 6,
          capabilities: ['lexical-search'],
        });

        expect(plan.artifacts.added).toBe(1);
        expect(plan.artifacts.changed).toBe(1);
        expect(plan.artifacts.removed).toBe(1);
        const paths = plan.artifacts.changes.map((change) => `${change.change}:${change.path}`);
        expect(paths).toContain('added:new.md');
        expect(paths).toContain('changed:edit.md');
      },
    );
  });

  it('treats a parser version change as invalidating every artifact', async () => {
    // A parser upgrade legitimately changes extracted structure, so promising a fast
    // incremental rebuild would be a lie the user pays for in minutes.
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'b.md': '# B' } },
      async (project) => {
        const first = await planIn(project.root);
        const previous: PreviousBuild = {
          buildId: BUILD_ID,
          artifactHashes: new Map(
            first.fingerprint.artifacts.map((a) => [a.artifactId, a.contentHash]),
          ),
          chunkCount: 9,
          capabilities: ['lexical-search'],
        };
        const olderLock = buildLockfile({
          ...LOCK_INPUTS,
          parserVersions: { markdown: '0.0.9', text: '0.1.0' },
        });

        const { plan } = await planIn(project.root, previous, olderLock);
        expect(plan.lock.changed).toBe(true);
        expect(plan.expectedWork.parseArtifacts).toBe(2);
        expect(plan.expectedWork.reuseArtifacts).toBe(0);
      },
    );
  });

  it('carries discovery warnings so a plan shows what will be skipped', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'photo.png': 'x', 'report.pdf': '%PDF' } },
      async (project) => {
        const { plan } = await planIn(project.root);
        expect(plan.warnings.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(plan.warnings)).toContain('photo.png');
      },
    );
  });

  it('validates against the committed plan schema', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const { plan } = await planIn(project.root);
      expect(planSchema.safeParse(plan).success).toBe(true);
    });
  });
});

describe('plan purity', () => {
  it('leaves the filesystem byte-identical, which is what makes it a plan', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'docs/b.md': '# B' } },
      async (project) => {
        const snapshot = (): string =>
          ['lore.yaml', 'a.md', 'docs/b.md']
            .map((file) => `${file}:${readFileSync(project.path(file), 'utf8')}`)
            .join('|');

        const before = snapshot();
        await planIn(project.root);
        await planIn(project.root);
        expect(snapshot()).toBe(before);
      },
    );
  });

  it('creates no lockfile and no build directory', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      await planIn(project.root);
      expect(readLockfile(project.root)).toBeNull();
      expect(() => readFileSync(join(project.root, '.lore', 'state.sqlite'))).toThrow();
    });
  });

  it('produces an identical plan when run twice', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const first = await planIn(project.root);
      const second = await planIn(project.root);
      expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
    });
  });
});

describe('rendering', () => {
  it('follows the architecture section 6.10 shape', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'b.md': '# B' } },
      async (project) => {
        const { plan } = await planIn(project.root);
        const text = renderPlan(plan);

        expect(text).toContain('Artifacts');
        expect(text).toMatch(/\+ \d+ added/);
        expect(text).toMatch(/~ \d+ changed/);
        expect(text).toMatch(/- \d+ removed/);
        expect(text).toMatch(/= \d+ reused/);
        expect(text).toContain('Expected work');
        // #150: one total split two ways, so it agrees with the `2/2` the build's parsing
        // stage prints. "parse 2" beside "Parsing 2/2" described the same work twice.
        expect(text).toContain('2 artifacts to process: 2 parsed, 0 reused from cache');
      },
    );
  });

  it('agrees in number with itself, whatever the count', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'only.md': '# Only\n\nOne artifact.\n' } },
      async (project) => {
        const { plan } = await planIn(project.root);
        const text = renderPlan(plan);
        expect(text).toContain('1 artifact to process');
        expect(text).not.toContain('1 artifacts');
      },
    );
  });

  it('labels the chunk figure as an estimate, since an exact count needs a parse', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const { plan } = await planIn(project.root);
      expect(renderPlan(plan)).toContain('about');
      expect(renderPlan(plan)).toMatch(/about \d+ chunks? rebuilt/);
    });
  });

  it('lists individual changes for a small change set but not a large one', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const { plan } = await planIn(project.root);
      expect(renderPlan(plan)).toContain('a.md');

      const many = {
        ...plan,
        artifacts: {
          ...plan.artifacts,
          changes: Array.from({ length: 40 }, (_, i) => ({
            path: `file-${i}.md`,
            change: 'added' as const,
          })),
        },
      };
      expect(renderPlan(many)).not.toContain('file-39.md');
    });
  });
});
