import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildSnapshot, diffBuilds, renderDiff } from '@lorepack/compiler';
import { type BuildId, buildDiffSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function project<T>(
  files: Record<string, string>,
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, async (temp) =>
    body(temp.root, (args) => run(['--cwd', temp.root, ...args])),
  );
}

function build(root: string) {
  return runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
}

const BASE_ARTIFACT = {
  id: 'p:a.md',
  relativePath: 'a.md',
  contentHash: 'c'.repeat(64),
  status: 'current',
  authority: 50,
  supersedes: [] as string[],
};

const BASE: BuildSnapshot = {
  buildId: `lore_${'1'.repeat(64)}` as BuildId,
  formatVersion: 1,
  schemaVersion: 1,
  compilerVersion: '0.1.0',
  capabilities: ['lexical-search', 'structured-context'],
  canonicalRoots: { artifacts: 'a'.repeat(64), chunks: 'b'.repeat(64) },
  artifacts: [BASE_ARTIFACT],
  chunks: [{ id: 'p:a.md#0', revisionHash: 'd'.repeat(64) }],
  tables: [],
};

function snapshot(overrides: Partial<BuildSnapshot>): BuildSnapshot {
  return { ...BASE, buildId: `lore_${'2'.repeat(64)}` as BuildId, ...overrides };
}

describe('diff engine', () => {
  it('reports no differences when a build is compared to itself', () => {
    const diff = diffBuilds(BASE, BASE);
    expect(diff.identical).toBe(true);
    expect(renderDiff(diff)).toContain('No differences');
  });

  it('separates added, changed and removed artifacts', () => {
    const diff = diffBuilds(
      BASE,
      snapshot({
        artifacts: [
          { ...BASE_ARTIFACT, contentHash: 'e'.repeat(64) },
          {
            id: 'p:new.md',
            relativePath: 'new.md',
            contentHash: 'f'.repeat(64),
            status: 'current',
            authority: 50,
            supersedes: [],
          },
        ],
      }),
    );

    expect(diff.artifacts).toMatchObject({ added: 1, changed: 1, removed: 0 });
    expect(diff.artifacts.changes.map((change) => `${change.change}:${change.path}`)).toEqual([
      'changed:a.md',
      'added:new.md',
    ]);
  });

  it('reports a pure rename as remove plus add, noting the shared content', () => {
    // Lorepack never claims to have detected an intent. It reports the pair and lets the
    // reader conclude it was a move.
    const diff = diffBuilds(
      BASE,
      snapshot({
        artifacts: [{ ...BASE_ARTIFACT, id: 'p:b.md', relativePath: 'b.md' }],
      }),
    );

    expect(diff.artifacts).toMatchObject({ added: 1, removed: 1, changed: 0 });
    expect(diff.artifacts.changes).toEqual([
      { path: 'a.md', change: 'removed', sameContentAs: 'b.md' },
      { path: 'b.md', change: 'added', sameContentAs: 'a.md' },
    ]);
    expect(renderDiff(diff)).toContain('same content as');
  });

  it('summarises chunk changes as counts rather than dumping them', () => {
    const diff = diffBuilds(
      BASE,
      snapshot({
        chunks: [
          { id: 'p:a.md#0', revisionHash: 'z'.repeat(64) },
          { id: 'p:a.md#1', revisionHash: 'y'.repeat(64) },
        ],
      }),
    );
    expect(diff.chunks).toEqual({ added: 1, changed: 1, removed: 0 });
    // #167: this asserted `+ 1 chunks`, which is how the defect survived #150. A test can
    // lock one in as easily as it can catch one.
    const rendered = renderDiff(diff);
    expect(rendered).toContain('+ 1 chunk');
    expect(rendered).not.toContain('1 chunks');
  });

  it('reports declared ranking hints moving, without judging them', () => {
    const diff = diffBuilds(
      BASE,
      snapshot({
        artifacts: [
          {
            ...BASE_ARTIFACT,
            authority: 100,
            status: 'superseded',
            supersedes: ['p:old.md'],
          },
        ],
      }),
    );

    expect(diff.rules).toEqual([
      { path: 'a.md', field: 'authority', from: '50', to: '100' },
      { path: 'a.md', field: 'status', from: 'current', to: 'superseded' },
      { path: 'a.md', field: 'supersedes', from: null, to: 'p:old.md' },
    ]);
  });

  it('marks capability gains and losses', () => {
    const diff = diffBuilds(BASE, snapshot({ capabilities: ['lexical-search', 'table-query'] }));
    expect(diff.capabilities).toEqual([
      { capability: 'lexical-search', change: 'same' },
      { capability: 'structured-context', change: 'removed' },
      { capability: 'table-query', change: 'added' },
    ]);
  });

  it('states a schema difference instead of producing a misleading diff', () => {
    const diff = diffBuilds(BASE, snapshot({ schemaVersion: 2 }));
    expect(diff.incompatibilities).toEqual([{ field: 'schemaVersion', from: '1', to: '2' }]);
    expect(renderDiff(diff)).toContain('may be misleading');
  });

  it('reports which canonical roots moved', () => {
    const diff = diffBuilds(
      BASE,
      snapshot({ canonicalRoots: { artifacts: 'a'.repeat(64), chunks: '9'.repeat(64) } }),
    );
    expect(diff.canonicalRoots.find((root) => root.root === 'chunks')?.changed).toBe(true);
    expect(diff.canonicalRoots.find((root) => root.root === 'artifacts')?.changed).toBe(false);
  });
});

describe('lore diff', () => {
  it('compares the previous build to the active one by default', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nEdited text.', 'utf8');
      const second = await build(root);

      const result = await lore(['diff']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(first.buildId.slice(0, 17));
      expect(result.stdout).toContain(second.buildId.slice(0, 17));
      expect(result.stdout).toContain('~ a.md');
    });
  });

  it('never re-reads sources, proven by deleting them first', async () => {
    // This is the property that makes diff instant and rollback comparisons free.
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root, lore) => {
      await build(root);
      rmSync(join(root, 'b.md'));
      await build(root);

      rmSync(join(root, 'a.md'));
      const result = await lore(['diff']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('- b.md');
    });
  });

  it('emits JSON validating against the committed schema with both ids in full', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nEdited.', 'utf8');
      const second = await build(root);

      const parsed = JSON.parse((await lore(['--json', 'diff'])).stdout);
      expect(buildDiffSchema.safeParse(parsed).success).toBe(true);
      expect(parsed.from).toBe(first.buildId);
      expect(parsed.to).toBe(second.buildId);
    });
  });

  it('accepts an unambiguous prefix and reports no differences for a build against itself', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const built = await build(root);
      const result = await lore(['diff', built.buildId.slice(0, 12), built.buildId]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No differences');
    });
  });

  it('fails with the available builds listed when the id is unknown', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const built = await build(root);
      const result = await lore(['diff', 'lore_deadbeef', built.buildId]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(result.stderr).toContain(built.buildId);
    });
  });

  it('says plainly that one build cannot be compared with nothing', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      const result = await lore(['diff']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('only one build');
    });
  });

  it('detects a rename end to end', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      renameSync(join(root, 'a.md'), join(root, 'renamed.md'));
      await build(root);

      const result = await lore(['diff']);
      expect(result.stdout).toContain('same content as');
    });
  });
});
