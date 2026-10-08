#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matchesLocation } from './bench-quality.mjs';
import { redactSecrets } from './rag-benchmark-security.mjs';

const buildDatabasePath = process.argv[2];
const metadata = JSON.parse(process.argv[3] ?? '{}');
if (buildDatabasePath === undefined) throw new Error('A Lorepack context.sqlite path is required.');

const WORKLOAD = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'benchmarks/corpus/queries.json'), 'utf8'),
);
const MODE = metadata.mode ?? 'offline';
if (!['offline', 'hosted'].includes(MODE))
  throw new Error(`Unsupported RAG benchmark mode: ${MODE}`);
const TOP_K = metadata.topK ?? 5;
const CONTEXT_BUDGET = metadata.contextBudgetTokens ?? 1200;
const SAMPLES = 3;
const QUERY_ITERATIONS = 30;
const CONTEXT_ITERATIONS = 20;
const PROMPT_TEMPLATE =
  'Answer using only the supplied context. Cite each source as [source: <path>].';

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Math.round((sorted[position] ?? 0) * 100) / 100;
}

function peakRssMiB() {
  const maxRssBytes = Math.max(
    process.memoryUsage().rss,
    (process.resourceUsage().maxRSS ?? 0) * 1024,
  );
  return Math.round((maxRssBytes / 1024 ** 2) * 100) / 100;
}

function estimateTokens(value) {
  const words = value.trim() === '' ? 0 : value.trim().split(/\s+/u).length;
  return Math.ceil(words * 1.3);
}

function readChunks() {
  const db = new DatabaseSync(buildDatabasePath, { readOnly: true });
  const rows = db
    .prepare(
      'SELECT id, relative_path AS path, heading_path AS heading, text AS body, line_start AS lineStart, line_end AS lineEnd, page FROM chunks ORDER BY id',
    )
    .all();
  db.close();
  return rows;
}

function createIndex(rows, path) {
  const started = performance.now();
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, path, heading, body, lineStart UNINDEXED, lineEnd UNINDEXED, page UNINDEXED)',
  );
  db.exec('BEGIN');
  const insert = db.prepare(
    'INSERT INTO chunks_fts (id, path, heading, body, lineStart, lineEnd, page) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.path,
      row.heading,
      row.body,
      row.lineStart ?? null,
      row.lineEnd ?? null,
      row.page ?? null,
    );
  }
  db.exec('COMMIT');
  db.exec('PRAGMA optimize');
  db.close();
  return performance.now() - started;
}

function query(db, text) {
  const normalized = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).join(' OR ');
  return db
    .prepare(
      `SELECT id, path, heading, body, lineStart, lineEnd, page, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ${TOP_K}`,
    )
    .all(normalized);
}

function locator(row) {
  return {
    relativePath: row.path,
    headingPath: JSON.parse(row.heading || '[]'),
    lineStart: row.lineStart ?? undefined,
    lineEnd: row.lineEnd ?? undefined,
    page: row.page ?? undefined,
  };
}

function assembleContext(rows) {
  const selected = [];
  let usedTokens = 0;
  for (const row of rows) {
    const source = `[source: ${row.path}]\n${row.body}`;
    const tokens = estimateTokens(source);
    if (selected.length > 0 && usedTokens + tokens > CONTEXT_BUDGET) continue;
    selected.push({ row, source, tokens, locator: locator(row) });
    usedTokens += tokens;
  }
  return {
    selected,
    omitted: rows.length - selected.length,
    tokens: usedTokens,
  };
}

function buildPrompt(task, context) {
  return `${PROMPT_TEMPLATE}\n\nQuestion: ${task}\n\nContext:\n${context.selected.map((item) => item.source).join('\n\n')}`;
}

function requiredSecret(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required for hosted mode.`);
  return value;
}

async function requestHosted(prompt) {
  const endpoint = requiredSecret('RAG_BENCH_ENDPOINT');
  const apiKey = requiredSecret('RAG_BENCH_API_KEY');
  const model = requiredSecret('RAG_BENCH_MODEL');
  const started = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: Number(process.env.RAG_BENCH_TEMPERATURE ?? 0),
        messages: [
          { role: 'system', content: PROMPT_TEMPLATE },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (error) {
    throw new Error(
      `Hosted RAG request failed: ${redactSecrets(String(error), process.env.RAG_BENCH_API_KEY)}`,
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Hosted RAG request returned ${response.status}.`);
  return {
    elapsed: performance.now() - started,
    answer: body.choices?.[0]?.message?.content ?? '',
    usage: body.usage ?? {},
  };
}

function sourceMentioned(answer, expected) {
  const normalized = answer.toLowerCase();
  return (
    normalized.includes(expected.artifact.toLowerCase()) ||
    normalized.includes(expected.artifact.split('/').at(-1).toLowerCase())
  );
}

function answerQuality(answerCases) {
  const hosted = MODE === 'hosted';
  const citationCases = answerCases.filter((entry) => hosted && entry.answer !== null);
  const citationNumerator = citationCases.filter((entry) =>
    entry.expected.every((expected) => sourceMentioned(entry.answer, expected)),
  ).length;
  return {
    status: hosted ? 'measured' : 'not-measured',
    cases: answerCases.length,
    citationCoverage: {
      numerator: citationNumerator,
      denominator: citationCases.length,
    },
    taskSuccess: { numerator: 0, denominator: 0 },
    reason: hosted
      ? 'Citation coverage checks explicit source mentions. Task success requires a labelled answer evaluator and is not measured.'
      : 'Offline mode assembles prompts but does not call a model, so answer quality is not measured.',
  };
}

const rows = readChunks();
const directory = mkdtempSync(join(tmpdir(), 'lorepack-rag-baseline-'));
const indexSamples = [];
let indexBytes = 0;
let totalInputTokens = 0;
let totalRetrievedContextTokens = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalModelTokens = 0;
let totalProviderPromptTokens = 0;
let providerUsageComplete = true;
const answerCases = [];

function recordHostedUsage(usage) {
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  if (![promptTokens, completionTokens, totalTokens].every(Number.isInteger)) {
    providerUsageComplete = false;
    return;
  }
  totalProviderPromptTokens += promptTokens;
  totalCompletionTokens += completionTokens;
  totalModelTokens += totalTokens;
}
try {
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const path = join(directory, `rag-${sample}.sqlite`);
    indexSamples.push(createIndex(rows, path));
    indexBytes = statSync(path).size;
    rmSync(path, { force: true });
  }

  const path = join(directory, 'rag.sqlite');
  createIndex(rows, path);
  const coldStarted = performance.now();
  const coldDb = new DatabaseSync(path, { readOnly: true });
  query(coldDb, WORKLOAD.searchQueries[0]);
  coldDb.close();
  const coldSearchMs = Math.round((performance.now() - coldStarted) * 100) / 100;

  const db = new DatabaseSync(path, { readOnly: true });
  const warm = [];
  const topK = [];
  for (let index = 0; index < QUERY_ITERATIONS; index += 1) {
    const started = performance.now();
    const result = query(db, WORKLOAD.searchQueries[index % WORKLOAD.searchQueries.length]);
    warm.push(performance.now() - started);
    topK.push(result.length);
  }

  const contextSamples = [];
  const promptSamples = [];
  const modelSamples = [];
  for (let index = 0; index < CONTEXT_ITERATIONS; index += 1) {
    const task = WORKLOAD.contextTasks[index % WORKLOAD.contextTasks.length];
    const retrievalStarted = performance.now();
    const candidates = query(db, task);
    const context = assembleContext(candidates);
    contextSamples.push(performance.now() - retrievalStarted);
    const promptStarted = performance.now();
    const prompt = buildPrompt(task, context);
    promptSamples.push(performance.now() - promptStarted);
    const inputTokens = estimateTokens(task);
    const promptTokens = estimateTokens(prompt);
    totalInputTokens += inputTokens;
    totalRetrievedContextTokens += context.tokens;
    totalPromptTokens += promptTokens;
    if (MODE === 'hosted') {
      const result = await requestHosted(prompt);
      modelSamples.push(result.elapsed);
      recordHostedUsage(result.usage);
    }
  }

  for (const entry of WORKLOAD.qualityQueries) {
    const candidates = query(db, entry.query);
    if (entry.kind === 'search') {
      answerCases.push({ ...entry, hits: candidates.map((row) => ({ locator: locator(row) })) });
      continue;
    }
    const context = assembleContext(candidates);
    const prompt = buildPrompt(entry.query, context);
    let answer = null;
    if (MODE === 'hosted') {
      const result = await requestHosted(prompt);
      modelSamples.push(result.elapsed);
      recordHostedUsage(result.usage);
      answer = result.answer;
    }
    answerCases.push({
      ...entry,
      citations: context.selected.map((item) => item.locator),
      answer,
    });
  }
  db.close();
  const peak = peakRssMiB();
  rmSync(path, { force: true });

  const searches = answerCases.filter((entry) => entry.kind === 'search');
  const contexts = answerCases.filter((entry) => entry.kind === 'context');
  const hit = (entry, limit) =>
    entry.expected.some((expected) =>
      entry.hits.slice(0, limit).some((actual) => matchesLocation(actual.locator, expected)),
    );
  const cited = (entry) =>
    entry.expected.every((expected) =>
      entry.citations.some((actual) => matchesLocation(actual, expected)),
    );
  const tokenStatus = 'estimated';
  const model = MODE === 'hosted' ? requiredSecret('RAG_BENCH_MODEL') : null;
  const tokenizer =
    MODE === 'hosted'
      ? (process.env.RAG_BENCH_TOKENIZER ?? 'provider-reported')
      : 'rag-estimator-v1';
  const reportedPromptTokens =
    MODE === 'hosted' && providerUsageComplete ? totalProviderPromptTokens : totalPromptTokens;
  const totalTokens =
    MODE === 'hosted' && providerUsageComplete ? totalModelTokens : totalPromptTokens;
  const inputTokens = totalInputTokens;
  const completionTokens = MODE === 'hosted' ? totalCompletionTokens : null;
  const priceInput = Number(process.env.RAG_BENCH_INPUT_USD_PER_MILLION ?? '');
  const priceOutput = Number(process.env.RAG_BENCH_OUTPUT_USD_PER_MILLION ?? '');
  const canPrice =
    MODE === 'hosted' &&
    providerUsageComplete &&
    Number.isFinite(priceInput) &&
    Number.isFinite(priceOutput);
  const inputCost = canPrice ? (reportedPromptTokens / 1_000_000) * priceInput : null;
  const outputCost = canPrice ? (totalCompletionTokens / 1_000_000) * priceOutput : null;
  const costTotal = inputCost === null ? null : inputCost + outputCost;
  console.log(
    JSON.stringify({
      protocol: { name: 'lorepack-benchmark', version: 1 },
      reportId: `rag-${metadata.corpus?.scale ?? 'unknown'}-${metadata.commitSha?.slice(0, 12)}`,
      generatedAt: new Date().toISOString(),
      commitSha: metadata.commitSha,
      implementation: { name: 'rag-offline-lexical', version: '1' },
      environment: {
        platform: process.platform,
        arch: process.arch,
        runner: metadata.runner ?? 'local',
        node: process.versions.node,
        cpu: cpus()[0]?.model ?? 'unknown',
        storageClass: metadata.storageClass ?? 'unknown',
      },
      corpus: metadata.corpus,
      workload: metadata.workload,
      samples: { warmup: 0, repetitions: CONTEXT_ITERATIONS, timeoutMs: 120_000 },
      tokenAccounting: {
        status: tokenStatus,
        tokenizer,
        model,
        inputTokens,
        retrievedContextTokens: totalRetrievedContextTokens,
        promptTokens: reportedPromptTokens,
        completionTokens,
        totalTokens,
      },
      costAccounting: {
        status: canPrice ? 'estimated' : 'not-applicable',
        currency: canPrice ? 'USD' : null,
        pricingSource: canPrice ? 'RAG_BENCH_*_USD_PER_MILLION environment variables' : null,
        inputUsd: inputCost,
        outputUsd: outputCost,
        totalUsd: costTotal,
      },
      measurements: {
        phases: [
          {
            name: 'index-build',
            p50Ms: percentile(indexSamples, 0.5),
            p95Ms: percentile(indexSamples, 0.95),
            samples: SAMPLES,
            errorCount: 0,
          },
          {
            name: 'cold-query',
            p50Ms: coldSearchMs,
            p95Ms: coldSearchMs,
            samples: 1,
            errorCount: 0,
          },
          {
            name: 'warm-query',
            p50Ms: percentile(warm, 0.5),
            p95Ms: percentile(warm, 0.95),
            samples: QUERY_ITERATIONS,
            errorCount: 0,
          },
          {
            name: 'context-assembly',
            p50Ms: percentile(contextSamples, 0.5),
            p95Ms: percentile(contextSamples, 0.95),
            samples: CONTEXT_ITERATIONS,
            errorCount: 0,
          },
          {
            name: 'prompt-construction',
            p50Ms: percentile(promptSamples, 0.5),
            p95Ms: percentile(promptSamples, 0.95),
            samples: CONTEXT_ITERATIONS,
            errorCount: 0,
          },
          ...(MODE === 'hosted'
            ? [
                {
                  name: 'model-generation',
                  p50Ms: percentile(modelSamples, 0.5),
                  p95Ms: percentile(modelSamples, 0.95),
                  samples: modelSamples.length,
                  errorCount: 0,
                },
              ]
            : []),
        ],
      },
      quality: {
        search: {
          cases: searches.length,
          hitAt1: searches.filter((entry) => hit(entry, 1)).length,
          hitAt5: searches.filter((entry) => hit(entry, 5)).length,
        },
        provenance: {
          numerator: contexts.reduce((sum, entry) => sum + entry.citations.length, 0),
          denominator: contexts.reduce((sum, entry) => sum + entry.citations.length, 0),
        },
        context: {
          cases: contexts.length,
          expectedCitations: contexts.filter(cited).length,
          selectedTokens: totalRetrievedContextTokens,
        },
        answer: answerQuality(contexts),
      },
      resources: {
        indexBytes,
        peakRssMiB: peak,
        topK: { min: Math.min(...topK), max: Math.max(...topK) },
      },
      configuration: {
        pipeline: 'retrieve -> assemble-context -> construct-prompt -> optional-model',
        retriever: 'SQLite FTS5 bm25',
        chunking: 'shared Lorepack normalized chunks',
        topK: String(TOP_K),
        contextBudgetTokens: String(CONTEXT_BUDGET),
        promptTemplate: PROMPT_TEMPLATE,
        mode: MODE,
        provider:
          MODE === 'hosted' ? (process.env.RAG_BENCH_PROVIDER ?? 'openai-compatible') : 'none',
        model: model ?? 'none',
        embeddingModel: 'none',
        temperature: process.env.RAG_BENCH_TEMPERATURE ?? '0',
        tokenizer,
        ranking: 'bm25(chunks_fts)',
        columns: ['path', 'heading', 'body'],
        normalization: 'Unicode word extraction with OR term expansion for user questions',
        sourceBoundary: 'offline lexical baseline over normalized chunks',
      },
      claims: [
        {
          id: 'rag-retrieval',
          status: 'quality-result',
          statement:
            'The offline RAG baseline reports retrieval quality separately from context assembly.',
          evidence: ['quality.search', 'quality.context'],
        },
        {
          id: 'rag-token-accounting',
          status: 'measured',
          statement: `The ${MODE} mode records token fields with explicit ${tokenStatus} status.`,
          evidence: ['tokenAccounting'],
        },
        {
          id: 'rag-answer-quality',
          status: MODE === 'hosted' ? 'quality-result' : 'not-measured',
          statement:
            'Answer citation coverage and task success are separate from retrieval hit metrics.',
          evidence: ['quality.answer'],
        },
      ],
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
