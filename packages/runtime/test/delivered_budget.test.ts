import { type ContextBundle, contextBundleSchema } from '@lorepack/core';
import { expect, it } from 'vitest';
import {
  estimateDeliveredTokens,
  fitDeliveredContext,
  MAXIMUM_CONTEXT_BYTES,
  measureContextRepresentations,
  omissionSummary,
} from '../src/context/budget.js';
import { identifyExecution, resolveExecutionPolicy } from '../src/context/execution.js';
import {
  createBundleMarkdownRenderer,
  moreCommandFor,
  renderBundleMarkdown,
} from '../src/context/render.js';
import { toolResult } from '../src/context/serialize.js';

async function fixture(budget = 4000): Promise<ContextBundle> {
  const task = "review 'quoted' rollback with 🙂 and \\";
  const binding = {
    corpusId: `corpus_${'c'.repeat(32)}`,
    namespaceId: `namespace_${'d'.repeat(32)}`,
    buildId: `lore_${'a'.repeat(64)}`,
  };
  const item = {
    chunkId: 'p:policy.md@0',
    text: 'Whole permission with its qualifier. '.repeat(20),
    estimatedTokens: 1,
    headingPath: ['"Permission" 🙂'],
    labels: [],
    locator: { artifactId: 'p:policy.md', relativePath: 'policy.md', lineStart: 1, lineEnd: 20 },
  };
  return {
    ...binding,
    sourceState: 'unknown',
    execution: await identifyExecution(
      resolveExecutionPolicy({
        profile: 'agent',
        budget,
        includeArchived: true,
        compilerVersion: '0.1.0',
      }),
      { ...binding, task, filters: [] },
    ),
    task,
    profile: 'agent',
    budget,
    candidateLimit: 1000,
    candidateLimitHit: true,
    candidateMatchMode: 'any',
    estimatedTokens: 1,
    reservedTokens: 0,
    overview: [],
    selected: [item],
    tables: [],
    alternatives: [],
    omitted: [],
    omissionSummary: omissionSummary([]),
    citations: [item.locator],
  };
}

it('counts Unicode, escaping, both MCP copies and its own estimate field', async () => {
  const bundle = fitDeliveredContext(await fixture());
  const outputs = [
    `${JSON.stringify(bundle, null, 2)}\n`,
    JSON.stringify(bundle),
    JSON.stringify(toolResult(bundle)),
    renderBundleMarkdown(bundle, {
      projectName: 'x'.repeat(100),
      sourceState: bundle.sourceState,
      moreCommand: moreCommandFor(bundle.task),
    }),
  ];
  for (const output of outputs) {
    expect(estimateDeliveredTokens(output)).toBeLessThanOrEqual(bundle.estimatedTokens);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(MAXIMUM_CONTEXT_BYTES);
  }
  expect(bundle.estimatedTokens).toBeLessThanOrEqual(bundle.budget);
  expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
});

it('keeps the whole unit at exact fit and removes it one estimate below', async () => {
  const initial = fitDeliveredContext(await fixture());
  const exact = fitDeliveredContext(await fixture(initial.estimatedTokens));
  expect(exact.selected).toHaveLength(1);
  expect(exact.estimatedTokens).toBe(exact.budget);
  const below = fitDeliveredContext(await fixture(exact.budget - 1));
  expect(below.selected).toHaveLength(0);
  expect(below.omissionSummary.reasons.budget).toBe(1);
  expect(below.omissionSummary.truncated).toBe(true);
});

it('bounds diagnostic detail with exact totals, including removed alternatives', async () => {
  const input = await fixture();
  const item = input.selected[0];
  if (item === undefined) throw new Error('Fixture has no evidence.');
  input.omitted = Array.from({ length: 1000 }, (_, index) => ({
    chunkId: `p:omitted${index}.md@0`,
    reason: 'diversity',
    estimatedTokens: 1,
    locator: { artifactId: `p:omitted${index}.md`, relativePath: `omitted${index}.md` },
  }));
  input.alternatives = Array.from({ length: 5 }, (_, index) => ({
    ...item,
    chunkId: `p:old${index}.md@0`,
    text: 'historical 🙂\\"\n'.repeat(2000),
    labels: ['archived'],
  }));
  const fitted = fitDeliveredContext(input);
  expect(fitted.omissionSummary.reasons.diversity).toBe(1000);
  expect(fitted.omissionSummary.total).toBe(
    1000 + 5 - fitted.alternatives.length + 1 - fitted.selected.length,
  );
  expect(fitted.omissionSummary.reported).toBe(fitted.omitted.length);
  expect(fitted.omissionSummary.truncated).toBe(true);
  expect(measureContextRepresentations(fitted).estimatedTokens).toBeLessThanOrEqual(4000);
  expect(contextBundleSchema.safeParse(fitted).success).toBe(true);
});

it('enforces the byte ceiling even with the largest explicit budget', async () => {
  const input = await fixture(1_000_000);
  const item = input.selected[0];
  if (item === undefined) throw new Error('Fixture has no evidence.');
  input.selected = [{ ...item, text: '🙂'.repeat(MAXIMUM_CONTEXT_BYTES / 4) }];
  const fitted = fitDeliveredContext(input);
  expect(fitted.selected).toHaveLength(0);
  expect(fitted.omissionSummary.reasons.budget).toBe(1);
  expect(measureContextRepresentations(fitted).bytes).toBeLessThanOrEqual(MAXIMUM_CONTEXT_BYTES);
});

it('refuses when mandatory framing cannot fit', async () => {
  const input = await fixture(1);
  expect(() => fitDeliveredContext(input)).toThrowError(
    expect.objectContaining({ code: 'LORE_E_LIMIT_EXCEEDED' }),
  );
});

it.each([
  {},
  { lineStart: 4 },
  { lineStart: 4, lineEnd: 4 },
  { lineStart: 4, lineEnd: 12 },
  { page: 2, sheet: 'Ignored', lineStart: 4 },
  { sheet: 'Budget' },
  { cellRange: 'A1:D3' },
  { sheet: 'Budget', cellRange: 'A1:D3' },
  { sheet: '', cellRange: '' },
])('keeps cached and direct Markdown identical for coordinates %j', async (coordinates) => {
  const input = await fixture();
  const item = input.selected[0];
  if (item === undefined) throw new Error('Fixture has no evidence.');
  item.locator = { artifactId: 'p:policy.md', relativePath: 'policy.md', ...coordinates };
  input.overview = [{ ...item, chunkId: 'p:policy.md@overview' }];
  const otherLocator = { artifactId: 'p:policy.md', relativePath: 'policy.md', page: 99 };
  input.selected.push({ ...item, chunkId: 'p:policy.md@other', locator: otherLocator });
  input.alternatives = [{ ...item, chunkId: 'p:policy.md@alternative', labels: ['archived'] }];
  input.omitted = [
    {
      chunkId: 'p:policy.md@omitted',
      reason: 'diversity',
      estimatedTokens: 1,
      locator: item.locator,
    },
  ];
  input.omissionSummary = omissionSummary(input.omitted);
  input.citations = [item.locator, otherLocator, item.locator];
  const render = createBundleMarkdownRenderer();
  for (const estimatedTokens of [0, 9999, 10000]) {
    input.estimatedTokens = estimatedTokens;
    const options = {
      projectName: 'Example',
      moreCommand: moreCommandFor(input.task),
      sourceState: input.sourceState,
    };
    expect(render(input, options)).toBe(renderBundleMarkdown(input, options));
  }
});

it('observes mutable locators in independent fits and public renders', async () => {
  const input = await fixture();
  const item = input.selected[0];
  if (item === undefined) throw new Error('Fixture has no evidence.');
  const options = {
    projectName: 'Example',
    moreCommand: moreCommandFor(input.task),
    sourceState: input.sourceState,
  };
  const first = fitDeliveredContext(input);
  const before = renderBundleMarkdown(first, options);
  expect(before).toContain('lines 1-20');
  item.locator.page = 12345;
  expect(renderBundleMarkdown(first, options)).toContain('page 12345');
  const second = fitDeliveredContext(input);
  expect(second).toEqual(referenceFit(input));
  expect(renderBundleMarkdown(second, options)).toContain('page 12345');
  expect(measureContextRepresentations(second).estimatedTokens).toBeLessThanOrEqual(
    second.estimatedTokens,
  );
});

it.each([999, 1000, 1001, 2499, 2500, 2501, 4000, 5000, 9999, 10000, 10001])(
  'preserves the uncached greedy result, order and accounting at budget %i',
  async (budget) => {
    const input = await fixture(budget);
    const item = input.selected[0];
    if (item === undefined) throw new Error('Fixture has no evidence.');
    const evidence = (kind: string, index: number) => ({
      ...item,
      chunkId: `p:${kind}${index}.md@0`,
      text: `${kind}${index} "🙂\n`.repeat(30 + index * 20),
      nativeUnit: { nodeIds: [`${kind}${index}`], status: 'complete' as const },
      locator: {
        artifactId: `p:${kind}${index}.md`,
        relativePath: `${kind}${index}.md`,
        lineStart: index + 1,
        lineEnd: index + 4,
      },
    });
    input.overview = [evidence('overview', 0), evidence('overview', 1)];
    input.selected = [evidence('selected', 0), evidence('selected', 1)];
    input.alternatives = [evidence('alternative', 0), evidence('alternative', 1)];
    input.omitted = Array.from({ length: 24 }, (_, index) => ({
      chunkId: `p:omitted${index}.md@0`,
      reason: 'diversity' as const,
      estimatedTokens: index + 1,
      locator: evidence('omitted', index).locator,
    }));
    input.omissionSummary = omissionSummary(input.omitted);
    const before = structuredClone(input);
    const expected = referenceFit(input);
    if (expected === null) {
      expect(() => fitDeliveredContext(input)).toThrowError(
        expect.objectContaining({ code: 'LORE_E_LIMIT_EXCEEDED' }),
      );
    } else {
      const actual = fitDeliveredContext(input);
      expect(actual).toEqual(expected);
      expect(measureContextRepresentations(actual)).toEqual(
        measureContextRepresentations(expected),
      );
      expect(measureContextRepresentations(actual).bytes).toBeLessThanOrEqual(
        MAXIMUM_CONTEXT_BYTES,
      );
    }
    expect(input).toEqual(before);
  },
);

function referenceFit(input: ContextBundle): ContextBundle | null {
  const removalOrder = [
    ...input.alternatives.toReversed(),
    ...input.selected.toReversed(),
    ...input.overview.toReversed(),
  ];
  for (let removed = 0; removed <= removalOrder.length; removed += 1) {
    const alternatives = input.alternatives.slice(
      0,
      Math.max(0, input.alternatives.length - removed),
    );
    const selected = input.selected.slice(
      0,
      Math.max(0, input.selected.length - Math.max(0, removed - input.alternatives.length)),
    );
    const overview = input.overview.slice(
      0,
      Math.max(
        0,
        input.overview.length -
          Math.max(0, removed - input.alternatives.length - input.selected.length),
      ),
    );
    const omitted: ContextBundle['omitted'] = [
      ...input.omitted,
      ...removalOrder.slice(0, removed).map((item) => ({
        chunkId: item.chunkId,
        reason: 'budget' as const,
        estimatedTokens: item.estimatedTokens,
        locator: item.locator,
        ...(item.nativeUnit === undefined
          ? {}
          : {
              nativeUnit: { nodeIds: [...item.nativeUnit.nodeIds], status: 'omitted' as const },
            }),
      })),
    ];
    const maximumDetails = removed === 0 ? Math.min(20, input.omitted.length) : 0;
    for (let details = maximumDetails; details >= 0; details -= 1) {
      const candidate: ContextBundle = {
        ...input,
        overview,
        selected,
        alternatives,
        citations: [...overview, ...selected].map((item) => item.locator),
        reservedTokens: overview.reduce((sum, item) => sum + item.estimatedTokens, 0),
        omitted: omitted.slice(0, details),
        omissionSummary: omissionSummary(omitted, details),
        estimatedTokens: 0,
      };
      let measured = measureContextRepresentations(candidate);
      while (measured.estimatedTokens > candidate.estimatedTokens) {
        candidate.estimatedTokens = measured.estimatedTokens;
        measured = measureContextRepresentations(candidate);
      }
      if (
        candidate.estimatedTokens <= candidate.budget &&
        measured.bytes <= MAXIMUM_CONTEXT_BYTES
      ) {
        return candidate;
      }
    }
  }
  return null;
}
it('counts complete table references and removes them honestly below exact fit, issue429', async () => {
  const input = await fixture();
  input.selected = [];
  const locator = {
    artifactId: 'p:rates.csv',
    relativePath: 'rates.csv',
    lineStart: 1,
    lineEnd: 2,
  };
  const table = {
    tableId: 'p:rates.csv#table',
    name: 'rates',
    descriptionChunkId: 'p:rates.csv@0',
    labels: [],
    locator,
    schemaReference: { buildId: input.buildId, tableId: 'p:rates.csv#table' },
  };
  input.tables = [table];
  const fitted = fitDeliveredContext(input);
  expect(fitted.tables).toEqual([table]);
  expect(fitted.citations).toEqual([locator]);
  expect(contextBundleSchema.safeParse(fitted).success).toBe(true);
  const exact = fitDeliveredContext({ ...input, budget: fitted.estimatedTokens });
  expect(exact.tables).toEqual([table]);
  const below = fitDeliveredContext({ ...input, budget: fitted.estimatedTokens - 1 });
  expect(below.tables).toEqual([]);
  expect(below.citations).toEqual([]);
  expect(below.omissionSummary.reasons.budget).toBe(1);
  expect(below.omissionSummary.total).toBe(1);
  expect(measureContextRepresentations(below).estimatedTokens).toBeLessThanOrEqual(below.budget);
});

it('bounds oversized table metadata without splitting or leaking its locator, issue429', async () => {
  const input = await fixture();
  input.selected = [];
  input.tables = [
    {
      tableId: 'p:rates.csv#table',
      name: 'rate '.repeat(20_000),
      descriptionChunkId: 'p:rates.csv@0',
      labels: [],
      locator: { artifactId: 'p:rates.csv', relativePath: 'rates.csv' },
      schemaReference: { buildId: input.buildId, tableId: 'p:rates.csv#table' },
    },
  ];
  const fitted = fitDeliveredContext(input);
  expect(fitted.tables).toEqual([]);
  expect(fitted.citations).toEqual([]);
  expect(fitted.omissionSummary.reasons.budget).toBe(1);
  expect(fitted.estimatedTokens).toBeLessThanOrEqual(fitted.budget);
});
