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
import { moreCommandFor, renderBundleMarkdown } from '../src/context/render.js';
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
