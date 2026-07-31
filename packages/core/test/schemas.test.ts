import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildManifestSchema, buildReceiptSchema, lockfileSchema } from '../src/schemas/build.js';
import { sourceLocatorSchema } from '../src/schemas/common.js';
import { configSchema, ruleSchema } from '../src/schemas/config.js';
import { deploymentReceiptSchema, planSchema } from '../src/schemas/plan.js';
import { PUBLIC_SCHEMAS } from '../src/schemas/registry.js';
import {
  contextBundleSchema,
  searchRequestSchema,
  sourceReadRequestSchema,
  tableQueryRequestSchema,
} from '../src/schemas/runtime.js';

const FULL_DIGEST = 'a'.repeat(64);
const BUILD_ID = `lore_${FULL_DIGEST}`;

/** Reports the first failing path, which is what makes a validation error actionable. */
function firstIssuePath(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) return '';
  return result.error.issues[0]?.path.join('.') ?? '';
}

describe('config schema', () => {
  const minimal = { version: 1, name: 'sarjbot', sources: ['./project-context'] };

  it('accepts the minimal generated configuration', () => {
    expect(configSchema.parse(minimal)).toEqual(minimal);
  });

  it('accepts the documented rules example', () => {
    const parsed = configSchema.parse({
      ...minimal,
      rules: [
        { match: 'archive/**', status: 'archived' },
        { match: 'requirements/current/**', status: 'active', authority: 100 },
        { match: 'requirements/v2.docx', supersedes: ['requirements/v1.docx'] },
      ],
      context: { defaultProfile: 'chat' },
    });
    expect(parsed.rules).toHaveLength(3);
  });

  it('rejects an unknown key and names it', () => {
    const result = configSchema.safeParse({ ...minimal, sourcs: ['./typo'] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('sourcs');
  });

  it('rejects an empty sources list', () => {
    expect(configSchema.safeParse({ ...minimal, sources: [] }).success).toBe(false);
  });

  it.each([-1, 101, 1.5])('rejects authority %s as out of range', (authority) => {
    const result = configSchema.safeParse({
      ...minimal,
      rules: [{ match: '**', authority }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rule that sets nothing', () => {
    expect(ruleSchema.safeParse({ match: '**' }).success).toBe(false);
  });

  it('rejects a project name with path or shell metacharacters', () => {
    for (const name of ['../escape', 'a/b', 'x;rm -rf', '']) {
      expect(configSchema.safeParse({ ...minimal, name }).success, name).toBe(false);
    }
  });
});

describe('manifest schema', () => {
  const manifest = {
    formatVersion: 1 as const,
    buildId: BUILD_ID,
    projectName: 'sarjbot',
    compilerVersion: '0.1.0',
    schemaVersion: 1,
    configurationHash: 'b'.repeat(64),
    sourceFingerprint: 'c'.repeat(64),
    canonicalRoots: {
      artifacts: 'd'.repeat(64),
      nodes: 'e'.repeat(64),
      chunks: 'f'.repeat(64),
      tables: '0'.repeat(64),
      objects: '1'.repeat(64),
    },
    capabilities: ['lexical-search', 'structured-context'] as const,
    counts: { artifacts: 184, nodes: 900, chunks: 12418, tables: 11, tableRows: 2104 },
    warnings: [],
  };

  it('accepts a complete lexical manifest', () => {
    expect(buildManifestSchema.parse(manifest).buildId).toBe(BUILD_ID);
  });

  it('rejects a truncated or uppercase build id', () => {
    expect(buildManifestSchema.safeParse({ ...manifest, buildId: 'lore_abc' }).success).toBe(false);
    expect(
      buildManifestSchema.safeParse({ ...manifest, buildId: `lore_${'A'.repeat(64)}` }).success,
    ).toBe(false);
  });

  it('rejects an unknown capability', () => {
    const result = buildManifestSchema.safeParse({ ...manifest, capabilities: ['telepathy'] });
    expect(result.success).toBe(false);
  });

  it('rejects semantic-search without a complete embedding profile', () => {
    const result = buildManifestSchema.safeParse({
      ...manifest,
      capabilities: ['lexical-search', 'semantic-search'],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('embedding profile');
  });

  it('accepts semantic-search when the profile is complete', () => {
    const result = buildManifestSchema.safeParse({
      ...manifest,
      capabilities: ['lexical-search', 'semantic-search'],
      embeddingProfile: {
        modelId: 'sentence-transformers/all-MiniLM-L6-v2',
        revision: 'e4ce9877',
        tokenizer: 'bert-base-uncased',
        pooling: 'mean',
        normalized: true,
        dimensions: 384,
        valueType: 'float32',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an embedding profile missing its revision', () => {
    const result = buildManifestSchema.safeParse({
      ...manifest,
      capabilities: ['semantic-search'],
      embeddingProfile: { modelId: 'x', dimensions: 384, valueType: 'float32' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative count', () => {
    const result = buildManifestSchema.safeParse({
      ...manifest,
      counts: { ...manifest.counts, chunks: -1 },
    });
    expect(firstIssuePath(result)).toBe('counts.chunks');
  });
});

describe('lockfile schema', () => {
  it('accepts the documented shape', () => {
    expect(
      lockfileSchema.parse({
        formatVersion: 1,
        compiler: '0.1.0',
        schema: 1,
        parsers: { markdown: '0.1.0', 'pdf-text': '0.1.0' },
        semantic: null,
      }).semantic,
    ).toBeNull();
  });

  it('requires semantic to be present, even when null', () => {
    expect(
      lockfileSchema.safeParse({ formatVersion: 1, compiler: '0.1.0', schema: 1, parsers: {} })
        .success,
    ).toBe(false);
  });
});

describe('build receipt schema', () => {
  it('accepts operational facts that never enter the build id', () => {
    const receipt = buildReceiptSchema.parse({
      buildId: BUILD_ID,
      startedAt: '2026-07-31T20:00:00Z',
      completedAt: '2026-07-31T20:00:04Z',
      durationMs: 4000,
      cache: { reusedArtifacts: 181, rebuiltArtifacts: 3 },
      platform: 'linux-x64',
      nodeVersion: '24.18.1',
    });
    expect(receipt.durationMs).toBe(4000);
  });

  it('rejects a non-ISO timestamp', () => {
    const result = buildReceiptSchema.safeParse({
      buildId: BUILD_ID,
      startedAt: '31/07/2026',
      completedAt: '2026-07-31T20:00:04Z',
      durationMs: 1,
      cache: { reusedArtifacts: 0, rebuiltArtifacts: 0 },
      platform: 'linux-x64',
      nodeVersion: '24.18.1',
    });
    expect(firstIssuePath(result)).toBe('startedAt');
  });
});

describe('locator schema', () => {
  it('accepts document, page, and spreadsheet locators', () => {
    for (const locator of [
      {
        artifactId: 'src:a.md',
        relativePath: 'a.md',
        headingPath: ['A', 'B'],
        lineStart: 1,
        lineEnd: 9,
      },
      { artifactId: 'src:a.pdf', relativePath: 'a.pdf', page: 12 },
      { artifactId: 'src:p.xlsx', relativePath: 'p.xlsx', sheet: 'prices', cellRange: 'A1:D20' },
    ]) {
      expect(sourceLocatorSchema.safeParse(locator).success).toBe(true);
    }
  });

  it.each([
    ['a\\b.md', 'backslash'],
    ['/abs/a.md', 'absolute'],
    ['C:/a.md', 'drive letter'],
  ])('rejects the non-canonical path %s', (relativePath) => {
    const result = sourceLocatorSchema.safeParse({ artifactId: 'x', relativePath });
    expect(result.success).toBe(false);
  });
});

describe('runtime contracts', () => {
  it('applies documented defaults to a search request', () => {
    const parsed = searchRequestSchema.parse({ query: 'pricing' });
    expect(parsed).toMatchObject({ limit: 10, includeArchived: false, debug: false });
  });

  it('rejects an empty or oversized query', () => {
    expect(searchRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ query: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('requires a source read to name an artifact or a path', () => {
    expect(sourceReadRequestSchema.safeParse({ lineStart: 1 }).success).toBe(false);
    expect(sourceReadRequestSchema.safeParse({ path: 'a.md' }).success).toBe(true);
  });

  it('refuses a context bundle that exceeds its own budget', () => {
    const bundle = {
      buildId: BUILD_ID,
      sourceState: 'clean' as const,
      task: 'Review pricing',
      profile: 'chat' as const,
      budget: 100,
      estimatedTokens: 101,
      reservedTokens: 10,
      overview: [],
      selected: [],
      tables: [],
      alternatives: [],
      omitted: [],
      citations: [],
    };
    const result = contextBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('never exceed its budget');
    expect(contextBundleSchema.safeParse({ ...bundle, estimatedTokens: 100 }).success).toBe(true);
  });

  it('caps table query sql at the D1 statement length limit', () => {
    const request = { tableId: 't', sql: `SELECT ${'x'.repeat(100_001)}` };
    expect(tableQueryRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('plan and deployment receipt', () => {
  const plan = {
    formatVersion: 1 as const,
    projectName: 'sarjbot',
    activeBuildId: null,
    generatedAt: '2026-07-31T20:00:00Z',
    sourceState: 'dirty' as const,
    artifacts: { added: 2, changed: 1, removed: 0, reused: 181, changes: [] },
    rules: [],
    tables: [],
    lock: { changed: false, changes: [] },
    capabilities: { current: [], next: ['lexical-search' as const] },
    expectedWork: { parseArtifacts: 3, reuseArtifacts: 181, rebuildChunks: 27 },
    warnings: [],
  };

  it('accepts a first-build plan with no active build', () => {
    expect(planSchema.parse(plan).activeBuildId).toBeNull();
  });

  it('accepts a deployment receipt in the documented shape', () => {
    const receipt = deploymentReceiptSchema.parse({
      formatVersion: 1,
      receiptId: 'r-1',
      target: 'cloudflare',
      project: 'sarjbot',
      buildId: BUILD_ID,
      previousBuildId: null,
      state: 'active',
      deployedAt: '2026-07-31T20:00:00Z',
      endpoint: 'https://context.example.com/mcp',
      capabilityLossAccepted: [],
      completedSteps: ['project', 'verify', 'activate'],
      verification: { search: 'passed', sourceRead: 'passed', tableQuery: 'passed' },
    });
    expect(receipt.state).toBe('active');
  });

  it('rejects an endpoint that is not a url', () => {
    const result = deploymentReceiptSchema.safeParse({
      formatVersion: 1,
      receiptId: 'r-1',
      target: 'cloudflare',
      project: 'p',
      buildId: BUILD_ID,
      previousBuildId: null,
      state: 'active',
      deployedAt: '2026-07-31T20:00:00Z',
      endpoint: 'not a url',
      capabilityLossAccepted: [],
      completedSteps: [],
      verification: { search: 'passed', sourceRead: 'passed', tableQuery: 'passed' },
    });
    expect(firstIssuePath(result)).toBe('endpoint');
  });
});

describe('public registry', () => {
  it('exposes every contract that has a committed JSON Schema', () => {
    expect(Object.keys(PUBLIC_SCHEMAS).sort()).toEqual(
      [
        'build-description',
        'build-manifest',
        'build-receipt',
        'context-bundle',
        'deployment-receipt',
        'lore-config',
        'lore-lock',
        'plan',
        'search-request',
        'search-result',
        'source-read-request',
        'source-read-result',
        'table-description',
        'table-query-request',
        'table-query-result',
        'task-context-request',
      ].sort(),
    );
  });

  it('converts every schema to draft-2020-12 JSON Schema', () => {
    for (const [name, schema] of Object.entries(PUBLIC_SCHEMAS)) {
      const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as {
        type?: string;
      };
      expect(json.type, name).toBe('object');
    }
  });
});
