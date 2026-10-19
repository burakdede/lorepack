import type {
  BuildHandle,
  BuildId,
  BuildManifest,
  BuildScope,
  CatalogArtifact,
  CatalogArtifactSummary,
  CatalogNode,
  CatalogSearchCriteria,
  CatalogSearchHit,
  CatalogStore,
  LoreRuntime,
  RuntimeDeps,
  TableStore,
} from '@lorepack/core';
import { LoreError } from '@lorepack/core';
import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';

/**
 * The runtime's own guarantees, over fake ports.
 *
 * Fakes rather than a real build, and deliberately: the point of #41 is that the runtime
 * reaches data only through ports, so a test that needed SQLite to exercise it would be
 * evidence the boundary had already leaked. The local ports are held to the same
 * behaviour by the contract suite in #52.
 */

const BUILD_A = `lore_${'a'.repeat(64)}` as BuildId;
const BUILD_B = `lore_${'b'.repeat(64)}` as BuildId;
const IDENTITY = {
  corpusId: `corpus_${'c'.repeat(32)}`,
  namespaceId: `namespace_${'d'.repeat(32)}`,
};

describe('selected provider contract, issue432', () => {
  it('refuses a provider that ignores selection and releases its wrong handle', async () => {
    const provider = new TrackingProvider();
    provider.activate(BUILD_B);
    const open = vi.fn();
    const runtime = createRuntime({ provider, open });
    await expect(runtime.describeBuild({ buildId: BUILD_A })).rejects.toMatchObject({
      code: 'LORE_E_BUILD_NOT_FOUND',
    });
    expect(open).not.toHaveBeenCalled();
    expect(provider.released).toBe(1);
  });
});

it('refuses context adapters that omit native closure and releases the captured reader, issue698', async () => {
  const provider = new TrackingProvider();
  const runtime = runtimeOver(provider, {
    open: async (handle) => {
      const scope = scopeFor(handle.buildId);
      vi.spyOn(scope.catalog, 'search').mockResolvedValue([hitIn(handle.buildId)]);
      return scope;
    },
  });
  await expect(
    runtime.contextForTask({
      task: 'match',
      budget: 8000,
      includeArchived: false,
      allowUnsupportedBudget: false,
    }),
  ).rejects.toMatchObject({
    code: 'LORE_E_SCHEMA_MISMATCH',
  });
  expect(provider.released).toBe(1);
  expect(provider.leaked).toBe(0);
});

function manifestFor(buildId: BuildId): BuildManifest {
  return {
    formatVersion: 1,
    buildId,
    projectName: 'demo',
    compilerVersion: '0.1.0',
    schemaVersion: 1,
    configurationHash: 'c'.repeat(64),
    sourceFingerprint: 'd'.repeat(64),
    canonicalRoots: {
      artifacts: 'e'.repeat(64),
      nodes: 'f'.repeat(64),
      chunks: '0'.repeat(64),
      tables: '1'.repeat(64),
      objects: '2'.repeat(64),
    },
    capabilities: ['lexical-search', 'structured-context'],
    counts: { artifacts: 1, nodes: 3, chunks: 2, tables: 0, tableRows: 0 },
    warnings: [],
  } as BuildManifest;
}

function hitIn(buildId: BuildId): CatalogSearchHit {
  return {
    chunkId: `${buildId.slice(5, 9)}:guides/a.md@0`,
    artifactId: `${buildId.slice(5, 9)}:guides/a.md`,
    relativePath: 'guides/a.md',
    displayPath: 'guides/a.md',
    headingPath: ['Guides'],
    page: null,
    sheet: null,
    cellRange: null,
    lineStart: 3,
    lineEnd: 4,
    status: 'active',
    authority: 50,
    estimatedTokens: 12,
    text: 'a match, and some words around it to give the chunk a body',
    title: 'A guide',
    bm25: -0.5,
    excerpt: 'a [match]',
  };
}

class FakeCatalog implements CatalogStore {
  constructor(private readonly buildId: BuildId) {}
  async manifest(): Promise<BuildManifest> {
    return manifestFor(this.buildId);
  }
  async artifacts(): Promise<readonly CatalogArtifactSummary[]> {
    const artifact = await this.artifact('guides/a.md');
    if (artifact === null) throw new Error('Expected the catalog artifact fixture.');
    return [{ ...artifact, byteSize: 64, parserId: 'fixture', chunkCount: 2, nodeCount: 3 }];
  }
  async countChunks(): Promise<number> {
    return 2;
  }
  async countWarnings(): Promise<number> {
    return 0;
  }
  async supersededArtifacts(): Promise<ReadonlySet<string>> {
    return new Set();
  }
  async artifact(idOrPath: string): Promise<CatalogArtifact | null> {
    if (idOrPath !== 'guides/a.md') return null;
    return {
      artifactId: `${this.buildId.slice(5, 9)}:guides/a.md`,
      relativePath: 'guides/a.md',
      displayPath: 'guides/a.md',
      title: 'A guide',
      status: 'active',
      authority: 50,
      mediaType: 'text/markdown',
      objectHash: 'f'.repeat(64),
    };
  }
  async nodes(): Promise<readonly CatalogNode[]> {
    return [
      {
        nodeId: 'n0',
        artifactId: `${this.buildId.slice(5, 9)}:guides/a.md`,
        kind: 'paragraph',
        ordinal: 0,
        title: null,
        text: 'the body of the only node',
        headingPath: ['Guides'],
        page: null,
        sheet: null,
        cellRange: null,
        lineStart: 3,
        lineEnd: 4,
      },
    ];
  }
  async search(
    _query: string,
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogSearchHit[]> {
    const hit = hitIn(this.buildId);
    return [
      {
        ...hit,
        ...(criteria.nativeUnits === true
          ? {
              nativeUnit: { nodeIds: [`${hit.artifactId}#0.1`], text: hit.text },
            }
          : {}),
      },
    ].slice(0, criteria.limit);
  }
}

const emptyTables: TableStore = {
  async list() {
    return [];
  },
  async describe() {
    return null;
  },
  async query() {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'no tables');
  },
};

/**
 * A provider that records every acquisition and release, so a leak is a number rather
 * than a suspicion, and that can be activated to a different build between calls.
 */
class TrackingProvider {
  active: BuildId = BUILD_A;
  generation = 1;
  acquired = 0;
  released = 0;
  readonly closed: BuildId[] = [];
  readonly outstanding = new Map<BuildId, number>();

  activate(buildId: BuildId): void {
    this.active = buildId;
    this.generation += 1;
  }

  async current(): Promise<{ buildId: BuildId; generation: number }> {
    return { buildId: this.active, generation: this.generation };
  }

  async acquire(): Promise<BuildHandle> {
    const buildId = this.active;
    const generation = this.generation;
    this.acquired += 1;
    this.outstanding.set(buildId, (this.outstanding.get(buildId) ?? 0) + 1);
    let released = false;
    const self = this;
    return {
      ...IDENTITY,
      buildId,
      generation,
      release(): void {
        if (released) return;
        released = true;
        self.released += 1;
        const refs = (self.outstanding.get(buildId) ?? 1) - 1;
        self.outstanding.set(buildId, refs);
        // A drained build that is no longer active is closed, once.
        if (refs === 0 && self.active !== buildId) self.closed.push(buildId);
      },
    };
  }

  get leaked(): number {
    return this.acquired - this.released;
  }
}

function runtimeOver(
  provider: TrackingProvider,
  overrides: Partial<RuntimeDeps> = {},
): LoreRuntime {
  return createRuntime({
    provider,
    open: async (handle) => scopeFor(handle.buildId),
    ...overrides,
  });
}

function scopeFor(buildId: BuildId): BuildScope {
  return {
    ...IDENTITY,
    buildId,
    catalog: new FakeCatalog(buildId),
    tables: emptyTables,
    objects: {
      async get() {
        return null;
      },
      async put() {
        return '';
      },
      async has() {
        return false;
      },
    },
  };
}

describe('source inventory identity, issue426', () => {
  it('refuses a provider that substitutes the active build for an unavailable selection', async () => {
    const provider = new TrackingProvider();
    const open = vi.fn();
    const runtime = createRuntime({ provider, open });
    await expect(runtime.listSources({ buildId: BUILD_B, offset: 1 })).rejects.toMatchObject({
      code: 'LORE_E_BUILD_NOT_FOUND',
    });
    expect(open).not.toHaveBeenCalled();
    expect(provider.acquired).toBe(1);
    expect(provider.released).toBe(1);
  });

  it('returns an empty final page with one captured reader and a complete envelope', async () => {
    const provider = new TrackingProvider();
    const artifacts = vi.fn(async () => []);
    const runtime = runtimeOver(provider, {
      open: async (handle) => {
        const scope = scopeFor(handle.buildId);
        scope.catalog.artifacts = artifacts;
        return scope;
      },
    });
    expect(await runtime.listSources({ limit: 1 })).toEqual({
      ...IDENTITY,
      buildId: BUILD_A,
      sourceState: 'unknown',
      artifacts: [],
      nextOffset: null,
    });
    expect(artifacts).toHaveBeenCalledExactlyOnceWith({ offset: 0, limit: 2 });
    expect(provider.acquired).toBe(1);
    expect(provider.released).toBe(1);
    expect(provider.leaked).toBe(0);
  });
});

describe('table listing identity, issue423', () => {
  it('keeps rows and envelope on A when B activates inside the table read', async () => {
    const provider = new TrackingProvider();
    const rows = [{ tableId: 'a-table', name: 'A table' }];
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = runtimeOver(provider, {
      freshness: async () => (provider.active === BUILD_A ? 'clean' : 'dirty'),
      open: async (handle) => ({
        ...scopeFor(handle.buildId),
        tables: {
          ...emptyTables,
          list: async () => {
            entered();
            await gate;
            return handle.buildId === BUILD_A ? rows : [];
          },
        },
      }),
    });
    const pending = runtime.listTables();
    await reading;
    provider.activate(BUILD_B);
    release();
    expect(await pending).toEqual({
      ...IDENTITY,
      buildId: BUILD_A,
      sourceState: 'clean',
      tables: rows,
    });
    expect(provider.acquired).toBe(1);
    expect(provider.released).toBe(1);
    expect(provider.closed).toEqual([BUILD_A]);
    expect(await runtime.listTables()).toEqual({
      ...IDENTITY,
      buildId: BUILD_B,
      sourceState: 'dirty',
      tables: [],
    });
    expect(provider.leaked).toBe(0);
  });
});

describe('the envelope', () => {
  it('carries operational corpus and namespace identity in runtime responses (#697)', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider);
    for (const result of [
      await runtime.describeBuild(),
      await runtime.search({ query: 'a', limit: 5, includeArchived: false, debug: false }),
      await runtime.contextForTask({
        task: 'a match',
        includeArchived: false,
        allowUnsupportedBudget: false,
      }),
      await runtime.readSource({ path: 'guides/a.md', lineStart: 3, lineEnd: 4 }),
    ]) {
      expect(result).toMatchObject(IDENTITY);
    }
    expect(provider.leaked).toBe(0);
  });
  it('stamps the build and freshness on every response shape', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider, { freshness: async () => 'clean' });

    const described = await runtime.describeBuild();
    const searched = await runtime.search({
      query: 'match',
      limit: 10,
      includeArchived: false,
      debug: false,
    });

    for (const response of [described, searched]) {
      expect(response.buildId).toBe(BUILD_A);
      expect(response.sourceState).toBe('clean');
    }
    // The full id, not the short form: a consumer has to be able to name the build back.
    expect(described.buildId).toHaveLength(BUILD_A.length);
    expect(described.shortBuildId).toBe(BUILD_A.slice(0, 17));
  });

  it('reports unknown freshness rather than failing when it cannot be established', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider, {
      freshness: async () => {
        // #147: a read of a sealed build is never failed by the source tree.
        throw new LoreError('LORE_E_ENVELOPE_EXCEEDED', 'too many files to check');
      },
    });

    const result = await runtime.search({
      query: 'match',
      limit: 10,
      includeArchived: false,
      debug: false,
    });

    expect(result.sourceState).toBe('unknown');
    expect(result.hits).toHaveLength(1);
    expect(provider.leaked).toBe(0);
  });

  it('defaults to unknown when nothing establishes freshness at all', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    expect((await runtime.describeBuild()).sourceState).toBe('unknown');
  });
});

describe('provenance', () => {
  it('gives every hit a locator built from the row it came from', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    const result = await runtime.search({
      query: 'match',
      limit: 10,
      includeArchived: false,
      debug: false,
    });

    const [hit] = result.hits;
    expect(hit?.locator.relativePath).toBe('guides/a.md');
    expect(hit?.locator.artifactId).toBe(hit?.artifactId);
    expect(hit?.locator.lineStart).toBe(3);
    expect(hit?.locator.headingPath).toEqual(['Guides']);
  });
});

describe('the handle', () => {
  it.each(['corpusId', 'namespaceId'] as const)(
    'refuses a matching digest opened in another %s before catalog reads (#697)',
    async (field) => {
      const provider = new TrackingProvider();
      const opened = scopeFor(BUILD_A);
      const read = vi.spyOn(opened.catalog, 'manifest');
      const runtime = runtimeOver(provider, {
        open: async () => ({
          ...opened,
          [field]: `${field === 'corpusId' ? 'corpus' : 'namespace'}_${'e'.repeat(32)}`,
        }),
      });
      await expect(runtime.describeBuild()).rejects.toMatchObject({ code: 'LORE_E_INTERNAL' });
      expect(read).not.toHaveBeenCalled();
      expect(provider.leaked).toBe(0);
    },
  );

  it('refuses an unsupported provider identity before opening a scope (#697)', async () => {
    const provider = new TrackingProvider();
    const open = vi.fn(async () => scopeFor(BUILD_A));
    const runtime = createRuntime({
      provider: {
        current: () => provider.current(),
        acquire: async () => ({ ...(await provider.acquire()), namespaceId: 'invalid' }),
      },
      open,
    });
    await expect(runtime.describeBuild()).rejects.toMatchObject({ code: 'LORE_E_SCHEMA_MISMATCH' });
    expect(open).not.toHaveBeenCalled();
    expect(provider.leaked).toBe(0);
  });
  it('releases on the success path, on every capability', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider);

    await runtime.describeBuild();
    await runtime.search({ query: 'a', limit: 5, includeArchived: false, debug: false });
    await runtime.listTables();
    await expect(runtime.describeTable('nope')).rejects.toThrow();
    await expect(runtime.queryTable({ tableId: 'nope', sql: 'SELECT 1' })).rejects.toThrow();
    await runtime.contextForTask({
      task: 'anything',
      includeArchived: false,
      allowUnsupportedBudget: false,
    });
    await runtime.readSource({ path: 'guides/a.md', lineStart: 3, lineEnd: 4 });

    expect(provider.acquired).toBe(7);
    expect(provider.leaked).toBe(0);
  });

  it('releases when the body throws, which is when a leak would matter most', async () => {
    const provider = new TrackingProvider();
    const runtime = createRuntime({
      provider,
      open: async () => {
        throw new LoreError('LORE_E_INTERNAL', 'the database is gone');
      },
    });

    await expect(runtime.describeBuild()).rejects.toMatchObject({ code: 'LORE_E_INTERNAL' });
    expect(provider.leaked).toBe(0);
  });

  it('refuses a scope that opened a different build than the one acquired', async () => {
    // The audit finding this boundary exists for: rows from two builds in one response.
    const provider = new TrackingProvider();
    const runtime = createRuntime({ provider, open: async () => scopeFor(BUILD_B) });

    await expect(
      runtime.search({ query: 'a', limit: 1, includeArchived: false, debug: false }),
    ).rejects.toMatchObject({ code: 'LORE_E_INTERNAL' });
    expect(provider.leaked).toBe(0);
  });
});

describe('activation, architecture section 15.2', () => {
  it('finishes an in-flight call on its captured build while the next sees the new one', async () => {
    const provider = new TrackingProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let opened = 0;
    const runtime = createRuntime({
      provider,
      open: async (handle) => {
        opened += 1;
        // The first call blocks inside the scope, which is where a real slow query would
        // be: after the handle is acquired and before the response is built.
        if (opened === 1) await gate;
        return scopeFor(handle.buildId);
      },
    });

    const inFlight = runtime.describeBuild();
    provider.activate(BUILD_B);
    const next = await runtime.describeBuild();

    release();
    const first = await inFlight;

    expect(first.buildId).toBe(BUILD_A);
    expect(next.buildId).toBe(BUILD_B);
    expect(provider.leaked).toBe(0);
    // The build that stopped being active closes once, after its last reader, not when
    // the pointer moved.
    expect(provider.closed).toEqual([BUILD_A]);
  });

  it('never mixes two builds into one response', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider);

    const before = await runtime.search({
      query: 'a',
      limit: 10,
      includeArchived: false,
      debug: false,
    });
    provider.activate(BUILD_B);
    const after = await runtime.search({
      query: 'a',
      limit: 10,
      includeArchived: false,
      debug: false,
    });

    for (const result of [before, after]) {
      const prefix = result.buildId.slice(5, 9);
      for (const hit of result.hits) {
        expect(hit.artifactId.startsWith(prefix)).toBe(true);
        expect(hit.locator.artifactId?.startsWith(prefix)).toBe(true);
      }
    }
    expect(before.buildId).not.toBe(after.buildId);
  });
});

describe('capabilities this phase has not delivered yet', () => {
  it('assembles a bundle over any port, bounded and cited', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    const bundle = await runtime.contextForTask({
      task: 'a match',
      includeArchived: false,
      allowUnsupportedBudget: false,
    });

    expect(bundle.buildId).toBe(BUILD_A);
    expect(bundle.profile).toBe('agent');
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(bundle.budget);
    for (const citation of bundle.citations) expect(citation.relativePath).not.toBe('');
  });

  it('reports a missing normalized body as corruption, not as an empty document', async () => {
    // The fake object store holds nothing, which is what a pruned or damaged build looks
    // like. Returning empty text with a citation attached would be the worst answer.
    const runtime = runtimeOver(new TrackingProvider());
    await expect(runtime.readSource({ path: 'guides/a.md' })).rejects.toMatchObject({
      code: 'LORE_E_OBJECT_CORRUPT',
    });
  });

  it('readSource works over any port, with no filesystem anywhere in sight', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    const result = await runtime.readSource({ path: 'guides/a.md', lineStart: 3, lineEnd: 4 });

    expect(result.text).toBe('the body of the only node');
    expect(result.locator.lineStart).toBe(3);
    expect(result.buildId).toBe(BUILD_A);
  });

  it.each([
    { range: { lineStart: 3 }, expected: 'the body of the only node' },
    { range: { lineEnd: 4 }, expected: 'the body of the only node' },
    { range: { headingPath: ['Guides'] }, expected: 'the body of the only node' },
    { range: { headingPath: [] }, expected: 'the whole normalized body' },
  ])('distinguishes source selectors from a whole read: $range', async ({ range, expected }) => {
    const scope = scopeFor(BUILD_A);
    const body = vi
      .spyOn(scope.objects, 'get')
      .mockResolvedValue(new TextEncoder().encode('the whole normalized body'));
    const runtime = runtimeOver(new TrackingProvider(), { open: async () => scope });
    const result = await runtime.readSource({ path: 'guides/a.md', ...range });
    expect(result.text).toBe(expected);
    if ('headingPath' in range && range.headingPath?.length === 0)
      expect(body).toHaveBeenCalledOnce();
    else expect(body).not.toHaveBeenCalled();
  });

  it.each(['path', 'id'] as const)('resolves a source using its %s namespace', async (mode) => {
    const scope = scopeFor(BUILD_A);
    const artifact = await scope.catalog.artifact('guides/a.md', 'path');
    if (artifact === null) throw new Error('Expected the catalog artifact fixture.');
    const lookup = vi.spyOn(scope.catalog, 'artifact').mockResolvedValue(artifact);
    const runtime = runtimeOver(new TrackingProvider(), { open: async () => scope });
    const address =
      mode === 'path' ? { path: artifact.relativePath } : { artifactId: artifact.artifactId };
    const result = await runtime.readSource({ ...address, lineStart: 3 });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      mode === 'path' ? artifact.relativePath : artifact.artifactId,
      mode,
    );
    expect(result.locator.artifactId).toBe(artifact.artifactId);
  });

  it('answers table calls as a build without tables, not as a missing method', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    expect(await runtime.listTables()).toEqual({
      ...IDENTITY,
      buildId: BUILD_A,
      sourceState: 'unknown',
      tables: [],
    });
    await expect(runtime.describeTable('sales')).rejects.toMatchObject({
      code: 'LORE_E_BUILD_NOT_FOUND',
    });
  });
});

describe('context selection through runtime ports', () => {
  it('translates all filters into catalog criteria and releases the selected build', async () => {
    const provider = new TrackingProvider();
    const scope = scopeFor(BUILD_A);
    const search = vi.spyOn(scope.catalog, 'search');
    const runtime = runtimeOver(provider, { open: async () => scope });
    const bundle = await runtime.contextForTask({
      task: 'match',
      includeArchived: false,
      allowUnsupportedBudget: false,
      filters: [
        { kind: 'path', value: 'guides/**' },
        { kind: 'type', value: '.md' },
        { kind: 'status', value: 'active' },
        { kind: 'status', value: 'draft' },
      ],
    });
    expect(search).toHaveBeenCalledExactlyOnceWith('match', {
      match: 'all',
      limit: 500,
      nativeUnits: true,
      pathGlob: 'guides/**',
      extension: '.md',
      statuses: ['active', 'draft'],
    });
    expect(bundle.buildId).toBe(BUILD_A);
    expect(provider.acquired).toBe(1);
    expect(provider.released).toBe(1);
    expect(provider.leaked).toBe(0);
  });

  it.each([false, true])(
    'offers historical duplicate text only after explicit expansion (%s)',
    async (includeArchived) => {
      const provider = new TrackingProvider();
      const scope = scopeFor(BUILD_A);
      const hit = hitIn(BUILD_A);
      const candidates: readonly CatalogSearchHit[] = [
        { ...hit, authority: 100, nativeUnit: { nodeIds: ['current#0'], text: hit.text } },
        {
          ...hit,
          chunkId: 'archived@0',
          artifactId: 'archived',
          relativePath: 'archive.md',
          status: 'archived',
          nativeUnit: { nodeIds: ['archived#0'], text: hit.text },
        },
        {
          ...hit,
          chunkId: 'superseded@0',
          artifactId: 'superseded',
          relativePath: 'old.md',
          nativeUnit: { nodeIds: ['superseded#0'], text: hit.text },
        },
      ];
      vi.spyOn(scope.catalog, 'search').mockResolvedValue(candidates);
      vi.spyOn(scope.catalog, 'supersededArtifacts').mockResolvedValue(new Set(['superseded']));
      const runtime = runtimeOver(provider, { open: async () => scope });
      const bundle = await runtime.contextForTask({
        task: 'match',
        includeArchived,
        allowUnsupportedBudget: false,
      });
      const delivered = [...bundle.overview, ...bundle.selected];
      expect(delivered.map((item) => item.chunkId)).toEqual([hit.chunkId]);
      if (includeArchived) {
        expect(bundle.alternatives).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              chunkId: 'archived@0',
              labels: ['archived'],
              locator: expect.objectContaining({ relativePath: 'archive.md' }),
            }),
            expect.objectContaining({
              chunkId: 'superseded@0',
              labels: ['superseded'],
              locator: expect.objectContaining({ relativePath: 'old.md' }),
            }),
          ]),
        );
        expect(bundle.alternatives).toHaveLength(2);
      } else {
        expect(bundle.alternatives).toEqual([]);
        expect(bundle.omitted).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ chunkId: 'archived@0', reason: 'archived' }),
            expect.objectContaining({ chunkId: 'superseded@0', reason: 'superseded' }),
          ]),
        );
      }
      expect(provider.released).toBe(1);
      expect(provider.leaked).toBe(0);
    },
  );
});
