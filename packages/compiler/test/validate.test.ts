import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, LoreNode } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
import type { Chunk } from '../src/chunk/chunk.js';
import { type ValidationInput, validateCandidate } from '../src/seal/validate.js';
import { FakeObjectStore } from './fake-object-store.js';

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'src:a.md',
    sourceId: 'src',
    relativePath: 'a.md',
    displayPath: 'a.md',
    mediaType: 'text/markdown',
    byteSize: 10,
    contentHash: 'a'.repeat(64),
    parserId: 'markdown',
    parserVersion: '0.1.0',
    status: 'active',
    authority: 50,
    supersedes: [],
    metadata: {},
    ...overrides,
  };
}

function node(id: string, overrides: Partial<LoreNode> = {}): LoreNode {
  return {
    id,
    artifactId: 'src:a.md',
    kind: 'paragraph',
    ordinal: 1,
    text: 'searchable content here',
    locator: { artifactId: 'src:a.md', relativePath: 'a.md', lineStart: 1, lineEnd: 1 },
    metadata: {},
    revisionHash: 'b'.repeat(64),
    ...overrides,
  };
}

function chunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: 'src:a.md@0',
    artifactId: 'src:a.md',
    nodeIds: ['src:a.md#0.1'],
    headingPath: [],
    text: 'searchable content here',
    estimatedTokens: 5,
    locator: { artifactId: 'src:a.md', relativePath: 'a.md', lineStart: 1, lineEnd: 1 },
    revisionHash: 'c'.repeat(64),
    ...overrides,
  };
}

async function baseInput(overrides: Partial<ValidationInput> = {}): Promise<ValidationInput> {
  const objects = new FakeObjectStore();
  const objectHash = await objects.put(new TextEncoder().encode('searchable content here'));
  return {
    db: {} as DatabaseSync,
    objects,
    artifacts: [
      { artifact: artifact(), nodes: [node('src:a.md#0.1')], chunks: [chunk()], objectHash },
    ],
    manifest: { buildId: 'lore_x', projectName: 'p' },
    secrets: [],
    integrityCheck: () => ({ ok: true, problems: [] }),
    search: () => [{ hit: true }],
    countRows: (_db, table) => (table === 'chunks' ? 1 : 1),
    ...overrides,
  };
}

const failed = (report: Awaited<ReturnType<typeof validateCandidate>>, check: string) =>
  report.failures.filter((failure) => failure.check === check);

describe('a healthy candidate', () => {
  it('passes every check', async () => {
    const report = await validateCandidate(await baseInput());
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('runs all eleven checks from architecture section 12.10', async () => {
    const report = await validateCandidate(await baseInput());
    expect(report.checksRun).toEqual(
      expect.arrayContaining([
        'artifact-identity',
        'node-integrity',
        'chunk-integrity',
        'chunk-provenance',
        'fts-parity',
        'supersession-graph',
        'object-checksums',
        'no-secrets-in-manifest',
        'smoke-search',
        'smoke-source-read',
        'database-integrity',
      ]),
    );
  });
});

describe('each check catches its own defect', () => {
  it('rejects an artifact without a content hash', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [{ ...input.artifacts[0], artifact: artifact({ contentHash: 'nope' }) }],
    } as ValidationInput;
    const report = await validateCandidate(broken);
    expect(failed(report, 'artifact-identity')[0]?.subject).toBe('src:a.md');
  });

  it('rejects two artifacts sharing an id', async () => {
    const input = await baseInput();
    const duplicated = {
      ...input,
      artifacts: [input.artifacts[0], input.artifacts[0]],
    } as ValidationInput;
    expect(failed(await validateCandidate(duplicated), 'artifact-identity').length).toBeGreaterThan(
      0,
    );
  });

  it('rejects a node pointing at a parent that does not exist', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [
        { ...input.artifacts[0], nodes: [node('src:a.md#0.1', { parentId: 'src:a.md#9.9' })] },
      ],
    } as ValidationInput;
    expect(failed(await validateCandidate(broken), 'node-integrity')[0]?.subject).toBe(
      'src:a.md#0.1',
    );
  });

  it('rejects a chunk referencing a node that does not exist', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [{ ...input.artifacts[0], chunks: [chunk({ nodeIds: ['src:a.md#9.9'] })] }],
    } as ValidationInput;
    const failure = failed(await validateCandidate(broken), 'chunk-integrity')[0];
    expect(failure?.message).toContain('src:a.md#9.9');
  });

  it('rejects a chunk with no provenance, since a result citing it could not be traced', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [
        {
          ...input.artifacts[0],
          chunks: [chunk({ locator: { artifactId: 'src:a.md', relativePath: '' } })],
        },
      ],
    } as ValidationInput;
    expect(failed(await validateCandidate(broken), 'chunk-provenance')).toHaveLength(1);
  });

  it('rejects a lexical index that does not match the chunk count', async () => {
    const input = await baseInput({ countRows: (_db, table) => (table === 'chunks' ? 5 : 3) });
    const failure = failed(await validateCandidate(input), 'fts-parity')[0];
    expect(failure?.message).toContain('unsearchable');
  });

  it('rejects a supersedes target that is not in the build', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [
        { ...input.artifacts[0], artifact: artifact({ supersedes: ['src:missing.md'] }) },
      ],
    } as ValidationInput;
    expect(failed(await validateCandidate(broken), 'supersession-graph')[0]?.message).toContain(
      'src:missing.md',
    );
  });

  it('rejects a supersession cycle, which cannot be resolved into a ranking', async () => {
    const objects = new FakeObjectStore();
    const objectHash = await objects.put(new TextEncoder().encode('body text here'));
    const a = artifact({ id: 'src:a.md', supersedes: ['src:b.md'] });
    const b = artifact({ id: 'src:b.md', supersedes: ['src:a.md'] });
    const input = await baseInput({
      objects,
      artifacts: [
        { artifact: a, nodes: [], chunks: [], objectHash },
        { artifact: b, nodes: [], chunks: [], objectHash },
      ],
    });
    const failure = failed(await validateCandidate(input), 'supersession-graph')[0];
    expect(failure?.message).toContain('cycle');
  });

  it('rejects a manifest containing a secret, without echoing the secret', async () => {
    const input = await baseInput({
      manifest: { token: 'super-secret-value-1234' },
      secrets: ['super-secret-value-1234'],
    });
    const report = await validateCandidate(input);
    const failure = failed(report, 'no-secrets-in-manifest')[0];
    expect(failure).toBeDefined();
    expect(JSON.stringify(report.failures)).not.toContain('super-secret-value-1234');
  });

  it('rejects a database that fails its integrity check', async () => {
    const input = await baseInput({
      integrityCheck: () => ({ ok: false, problems: ['page 4 is corrupt'] }),
    });
    expect(failed(await validateCandidate(input), 'database-integrity')[0]?.message).toContain(
      'page 4 is corrupt',
    );
  });

  it('rejects an index that returns nothing for a term taken from its own content', async () => {
    const input = await baseInput({ search: () => [] });
    expect(failed(await validateCandidate(input), 'smoke-search')).toHaveLength(1);
  });

  it('rejects a missing normalized body', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [{ ...input.artifacts[0], objectHash: 'f'.repeat(64) }],
    } as ValidationInput;
    const report = await validateCandidate(broken);
    expect(
      failed(report, 'object-checksums').length + failed(report, 'smoke-source-read').length,
    ).toBeGreaterThan(0);
  });
});

describe('empty builds', () => {
  it('validates an empty candidate without inventing failures', async () => {
    const input = await baseInput({
      artifacts: [],
      countRows: () => 0,
      search: () => [],
    });
    const report = await validateCandidate(input);
    expect(report.ok).toBe(true);
  });
});

describe('reporting', () => {
  it('names the check and the offending record, not just that the build failed', async () => {
    const input = await baseInput();
    const broken = {
      ...input,
      artifacts: [{ ...input.artifacts[0], chunks: [chunk({ nodeIds: [] })] }],
    } as ValidationInput;
    const failure = (await validateCandidate(broken)).failures[0];
    expect(failure?.check).toBe('chunk-integrity');
    expect(failure?.subject).toBe('src:a.md@0');
    expect(failure?.message.length).toBeGreaterThan(20);
  });

  it('reports every failure rather than stopping at the first', async () => {
    const input = await baseInput({
      integrityCheck: () => ({ ok: false, problems: ['bad'] }),
      search: () => [],
      countRows: (_db, table) => (table === 'chunks' ? 5 : 1),
    });
    const report = await validateCandidate(input);
    expect(new Set(report.failures.map((failure) => failure.check)).size).toBeGreaterThan(2);
  });
});
