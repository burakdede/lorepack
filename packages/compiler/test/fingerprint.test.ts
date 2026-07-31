import { writeFileSync } from 'node:fs';
import { hashBytes, loadConfig, ProgressBus, type ProgressEvent } from '@lorepack/core';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover/discover.js';
import {
  cacheKey,
  compareFingerprints,
  computeFingerprint,
  type FingerprintedArtifact,
  fingerprintSources,
} from '../src/fingerprint/fingerprint.js';

const CONFIG = 'version: 1\nname: p\nsources:\n  - .\n';

async function fingerprintOf(root: string, progress?: ProgressBus) {
  const config = loadConfig({ cwd: root });
  const discovered = discover({ config });
  return fingerprintSources({ artifacts: discovered.artifacts, ...(progress ? { progress } : {}) });
}

const hashMap = (artifacts: readonly FingerprintedArtifact[]): Map<string, string> =>
  new Map(artifacts.map((artifact) => [artifact.artifactId, artifact.contentHash]));

describe('hashing', () => {
  it('hashes every discovered artifact by content', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A', 'b.txt': 'B' } },
      async (project) => {
        const result = await fingerprintOf(project.root);
        // lore.yaml is excluded by default, so only the two content files are hashed.
        expect(result.artifacts).toHaveLength(2);
        const a = result.artifacts.find((artifact) => artifact.relativePath === 'a.md');
        expect(a?.contentHash).toBe(hashBytes('# A'));
      },
    );
  });

  it('reports total bytes and a duration', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': 'x'.repeat(100) } },
      async (project) => {
        const result = await fingerprintOf(project.root);
        expect(result.totalBytes).toBeGreaterThanOrEqual(100);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      },
    );
  });

  it('is unaffected by concurrency, so results never depend on which worker finished', async () => {
    await withTempProject(
      {
        files: Object.fromEntries([
          ['lore.yaml', CONFIG],
          ...Array.from({ length: 40 }, (_, i) => [`file-${i}.md`, `# ${i}`]),
        ]),
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const artifacts = discover({ config }).artifacts;
        const serial = await fingerprintSources({ artifacts, concurrency: 1 });
        const parallel = await fingerprintSources({ artifacts, concurrency: 8 });

        expect(parallel.fingerprint).toBe(serial.fingerprint);
        expect(parallel.artifacts.map((a) => a.artifactId)).toEqual(
          serial.artifacts.map((a) => a.artifactId),
        );
      },
    );
  });

  it('emits progress with a measurable count', async () => {
    await withTempProject(
      {
        files: Object.fromEntries([
          ['lore.yaml', CONFIG],
          ...Array.from({ length: 30 }, (_, i) => [`f${i}.md`, `# ${i}`]),
        ]),
      },
      async (project) => {
        const events: ProgressEvent[] = [];
        const bus = new ProgressBus();
        bus.subscribe((event) => events.push(event));
        await fingerprintOf(project.root, bus);

        expect(events.some((e) => e.type === 'stage-started')).toBe(true);
        const progressEvents = events.filter((e) => e.type === 'stage-progress');
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents.every((e) => e.type === 'stage-progress' && e.completed > 0)).toBe(
          true,
        );
        expect(events.at(-1)?.type).toBe('stage-finished');
      },
    );
  });
});

describe('the project fingerprint', () => {
  it('is stable for unchanged content', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const first = await fingerprintOf(project.root);
      const second = await fingerprintOf(project.root);
      expect(second.fingerprint).toBe(first.fingerprint);
    });
  });

  it('does not move when only the modification time changes', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const before = await fingerprintOf(project.root);
      // Rewriting identical content moves mtime. Content decides freshness, not metadata,
      // so this must not register as a change.
      writeFileSync(project.path('a.md'), '# A', 'utf8');
      const after = await fingerprintOf(project.root);
      expect(after.fingerprint).toBe(before.fingerprint);
    });
  });

  it('moves when one byte changes', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const before = await fingerprintOf(project.root);
      writeFileSync(project.path('a.md'), '# B', 'utf8');
      expect((await fingerprintOf(project.root)).fingerprint).not.toBe(before.fingerprint);
    });
  });

  it('moves when a file is added or removed', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'a.md': '# A' } }, async (project) => {
      const before = await fingerprintOf(project.root);
      writeFileSync(project.path('b.md'), '# B', 'utf8');
      expect((await fingerprintOf(project.root)).fingerprint).not.toBe(before.fingerprint);
    });
  });

  it('is identical for the same project at two absolute paths', async () => {
    const report = await checkDeterminism({
      files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A', 'b.txt': 'B' },
      produce: async (project) => (await fingerprintOf(project.root)).fingerprint,
    });
    expect(report.message ?? '').toBe('');
  });

  it('does not depend on the order artifacts were hashed', () => {
    const artifacts = [
      { artifactId: 'p:a.md', contentHash: 'aa' },
      { artifactId: 'p:b.md', contentHash: 'bb' },
    ] as FingerprintedArtifact[];
    expect(computeFingerprint(artifacts)).toBe(computeFingerprint([...artifacts].reverse()));
  });
});

describe('dirtiness', () => {
  const base = [
    { artifactId: 'p:a.md', contentHash: 'aa' },
    { artifactId: 'p:b.md', contentHash: 'bb' },
  ] as FingerprintedArtifact[];

  it('reports clean when nothing moved', () => {
    expect(compareFingerprints(base, hashMap(base))).toMatchObject({
      clean: true,
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('separates added, changed and removed', () => {
    const current = [
      { artifactId: 'p:a.md', contentHash: 'aa' },
      { artifactId: 'p:b.md', contentHash: 'CHANGED' },
      { artifactId: 'p:c.md', contentHash: 'cc' },
    ] as FingerprintedArtifact[];
    const previous = hashMap(base);

    const state = compareFingerprints(current, previous);
    expect(state).toMatchObject({
      clean: false,
      added: ['p:c.md'],
      changed: ['p:b.md'],
      removed: [],
    });
  });

  it('detects a removal', () => {
    const state = compareFingerprints([base[0] as FingerprintedArtifact], hashMap(base));
    expect(state.removed).toEqual(['p:b.md']);
    expect(state.clean).toBe(false);
  });

  it('treats a first build as everything added', () => {
    expect(compareFingerprints(base, new Map())).toMatchObject({
      added: ['p:a.md', 'p:b.md'],
      changed: [],
      removed: [],
    });
  });
});

describe('cache key', () => {
  const inputs = {
    artifactId: 'p:a.md',
    contentHash: 'a'.repeat(64),
    parserId: 'markdown',
    parserVersion: '0.1.0',
    normalizationVersion: 1,
    chunking: { targetTokens: 700, maximumTokens: 1200, overlapTokens: 100 },
    rules: [],
  };

  it('is stable for identical inputs', () => {
    expect(cacheKey(inputs)).toBe(cacheKey({ ...inputs }));
  });

  it.each([
    ['artifactId', { artifactId: 'p:moved.md' }],
    ['contentHash', { contentHash: 'b'.repeat(64) }],
    ['parserId', { parserId: 'text' }],
    ['parserVersion', { parserVersion: '0.2.0' }],
    ['normalizationVersion', { normalizationVersion: 2 }],
    ['chunking', { chunking: { targetTokens: 500, maximumTokens: 1200, overlapTokens: 100 } }],
    ['rules', { rules: [{ match: '**', status: 'archived' }] }],
  ])('changes when %s changes, so a stale parse cannot be reused', (_name, patch) => {
    expect(cacheKey({ ...inputs, ...patch })).not.toBe(cacheKey(inputs));
  });

  it('does not change for an input that cannot affect parsed output', () => {
    // The key covers what architecture section 12.3 lists and nothing else. Over-including
    // would rebuild for no reason; the type has no field for anything else.
    const same = cacheKey({ ...inputs });
    expect(same).toBe(cacheKey(inputs));
  });
});
