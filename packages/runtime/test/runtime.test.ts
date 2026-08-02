import type {
  BuildHandle,
  BuildId,
  BuildManifest,
  BuildScope,
  CatalogSearchCriteria,
  CatalogSearchHit,
  CatalogStore,
  LoreRuntime,
  RuntimeDeps,
  TableStore,
} from '@lorepack/core';
import { LoreError } from '@lorepack/core';
import { describe, expect, it } from 'vitest';
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
    lineStart: 3,
    lineEnd: 4,
    status: 'active',
    authority: 50,
    estimatedTokens: 12,
    bm25: -0.5,
    excerpt: 'a [match]',
  };
}

class FakeCatalog implements CatalogStore {
  constructor(private readonly buildId: BuildId) {}
  async manifest(): Promise<BuildManifest> {
    return manifestFor(this.buildId);
  }
  async countChunks(): Promise<number> {
    return 2;
  }
  async countWarnings(): Promise<number> {
    return 0;
  }
  async search(
    _query: string,
    criteria: CatalogSearchCriteria,
  ): Promise<readonly CatalogSearchHit[]> {
    return [hitIn(this.buildId)].slice(0, criteria.limit);
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

describe('the envelope', () => {
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
  it('releases on the success path, on every capability', async () => {
    const provider = new TrackingProvider();
    const runtime = runtimeOver(provider);

    await runtime.describeBuild();
    await runtime.search({ query: 'a', limit: 5, includeArchived: false, debug: false });
    await runtime.listTables();
    await expect(runtime.describeTable('nope')).rejects.toThrow();
    await expect(runtime.queryTable({ tableId: 'nope', sql: 'SELECT 1' })).rejects.toThrow();
    await expect(
      runtime.contextForTask({ task: 'anything', includeArchived: false }),
    ).rejects.toThrow();
    await expect(runtime.readSource({ path: 'guides/a.md' })).rejects.toThrow();

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
  it.each([
    ['contextForTask', 42],
    ['readSource', 44],
  ])('%s says which issue delivers it, rather than failing obscurely', async (name, issue) => {
    const runtime = runtimeOver(new TrackingProvider());
    const call =
      name === 'contextForTask'
        ? runtime.contextForTask({ task: 'x', includeArchived: false })
        : runtime.readSource({ path: 'guides/a.md' });

    await expect(call).rejects.toMatchObject({
      remediation: expect.stringContaining(`#${issue}`),
    });
  });

  it('answers table calls as a build without tables, not as a missing method', async () => {
    const runtime = runtimeOver(new TrackingProvider());
    expect(await runtime.listTables()).toEqual([]);
    await expect(runtime.describeTable('sales')).rejects.toMatchObject({
      code: 'LORE_E_BUILD_NOT_FOUND',
    });
  });
});
