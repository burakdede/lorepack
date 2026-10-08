#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export const BENCHMARK_PROTOCOL_VERSION = 1;

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CLAIM_STATUSES = new Set(['measured', 'reported-only', 'quality-result', 'not-measured']);
const TOKEN_STATUSES = new Set(['not-applicable', 'estimated', 'measured']);
const PHASES = new Set([
  'ingest',
  'build',
  'incremental-rebuild',
  'index-build',
  'index-warmup',
  'cold-query',
  'warm-query',
  'context-assembly',
  'prompt-construction',
  'table-query',
  'model-generation',
]);

function required(value, path, problems) {
  if (value === undefined || value === null || value === '') problems.push(`${path} is required`);
}

function nonNegative(value, path, problems) {
  if (!Number.isInteger(value) || value < 0)
    problems.push(`${path} must be a non-negative integer`);
}

function finiteNonNegative(value, path, problems) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    problems.push(`${path} must be a non-negative number`);
  }
}

function digest(value, path, problems) {
  if (typeof value !== 'string' || !HASH.test(value))
    problems.push(`${path} must be a lowercase SHA-256`);
}

function commitDigest(value, path, problems) {
  if (typeof value !== 'string' || !COMMIT.test(value)) {
    problems.push(`${path} must be a lowercase Git commit id`);
  }
}

function unknownKeys(value, allowed, path, problems) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(`${path}.${key} is not allowed`);
  }
}

function validatePhase(phase, index, problems) {
  const path = `measurements.phases[${index}]`;
  if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
    problems.push(`${path} must be an object`);
    return;
  }
  unknownKeys(phase, new Set(['name', 'p50Ms', 'p95Ms', 'samples', 'errorCount']), path, problems);
  required(phase.name, `${path}.name`, problems);
  if (!PHASES.has(phase.name)) problems.push(`${path}.name is not a supported phase`);
  for (const field of ['p50Ms', 'p95Ms'])
    finiteNonNegative(phase[field], `${path}.${field}`, problems);
  nonNegative(phase.samples, `${path}.samples`, problems);
  nonNegative(phase.errorCount, `${path}.errorCount`, problems);
  if (phase.samples === 0) problems.push(`${path}.samples must be greater than zero`);
  if (phase.p95Ms < phase.p50Ms) problems.push(`${path}.p95Ms must be at least p50Ms`);
  if (phase.errorCount > phase.samples) problems.push(`${path}.errorCount exceeds samples`);
}

function validateTokens(tokens, problems) {
  const path = 'tokenAccounting';
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    problems.push(`${path} must be an object`);
    return;
  }
  unknownKeys(
    tokens,
    new Set([
      'status',
      'tokenizer',
      'model',
      'inputTokens',
      'retrievedContextTokens',
      'promptTokens',
      'completionTokens',
      'totalTokens',
    ]),
    path,
    problems,
  );
  if (!TOKEN_STATUSES.has(tokens.status)) problems.push(`${path}.status is invalid`);
  for (const field of [
    'tokenizer',
    'model',
    'inputTokens',
    'retrievedContextTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
  ]) {
    if (!(field in tokens))
      problems.push(`${path}.${field} is required, use null when not applicable`);
  }
  for (const field of [
    'inputTokens',
    'retrievedContextTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
  ]) {
    if (tokens[field] !== null) nonNegative(tokens[field], `${path}.${field}`, problems);
  }
  if (tokens.status === 'not-applicable') {
    for (const field of [
      'tokenizer',
      'model',
      'inputTokens',
      'retrievedContextTokens',
      'promptTokens',
      'completionTokens',
      'totalTokens',
    ]) {
      if (tokens[field] !== null)
        problems.push(`${path}.${field} must be null when status is not-applicable`);
    }
  }
}

function validateCostAccounting(cost, problems) {
  if (cost === undefined) return;
  const path = 'costAccounting';
  unknownKeys(
    cost,
    new Set(['status', 'currency', 'pricingSource', 'inputUsd', 'outputUsd', 'totalUsd']),
    path,
    problems,
  );
  if (!['not-applicable', 'estimated', 'measured'].includes(cost.status))
    problems.push(`${path}.status is invalid`);
  for (const field of ['currency', 'pricingSource', 'inputUsd', 'outputUsd', 'totalUsd']) {
    if (!(field in cost))
      problems.push(`${path}.${field} is required, use null when not applicable`);
  }
  for (const field of ['inputUsd', 'outputUsd', 'totalUsd']) {
    if (cost[field] !== null) finiteNonNegative(cost[field], `${path}.${field}`, problems);
  }
  if (cost.status === 'not-applicable') {
    for (const field of ['currency', 'pricingSource', 'inputUsd', 'outputUsd', 'totalUsd']) {
      if (cost[field] !== null)
        problems.push(`${path}.${field} must be null when status is not-applicable`);
    }
  }
}

function validateAnswerQuality(answer, problems) {
  if (answer === undefined) return;
  const path = 'quality.answer';
  unknownKeys(
    answer,
    new Set(['status', 'cases', 'citationCoverage', 'taskSuccess', 'reason']),
    path,
    problems,
  );
  if (!['measured', 'not-measured'].includes(answer.status))
    problems.push(`${path}.status is invalid`);
  nonNegative(answer.cases, `${path}.cases`, problems);
  for (const field of ['citationCoverage', 'taskSuccess']) {
    const metric = answer[field];
    if (metric === undefined || metric === null || typeof metric !== 'object') {
      problems.push(`${path}.${field} is required`);
      continue;
    }
    unknownKeys(metric, new Set(['numerator', 'denominator']), `${path}.${field}`, problems);
    nonNegative(metric.numerator, `${path}.${field}.numerator`, problems);
    nonNegative(metric.denominator, `${path}.${field}.denominator`, problems);
    if (metric.numerator > metric.denominator)
      problems.push(`${path}.${field}.numerator exceeds denominator`);
  }
}

export function validateBenchmarkReport(report) {
  const problems = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return ['report must be an object'];
  }
  unknownKeys(
    report,
    new Set([
      'protocol',
      'reportId',
      'generatedAt',
      'commitSha',
      'implementation',
      'environment',
      'corpus',
      'workload',
      'samples',
      'tokenAccounting',
      'measurements',
      'quality',
      'costAccounting',
      'resources',
      'configuration',
      'claims',
    ]),
    'report',
    problems,
  );
  unknownKeys(report.protocol, new Set(['name', 'version']), 'protocol', problems);
  unknownKeys(report.implementation, new Set(['name', 'version']), 'implementation', problems);
  unknownKeys(
    report.environment,
    new Set(['platform', 'arch', 'runner', 'node', 'cpu', 'storageClass', 'sqlite']),
    'environment',
    problems,
  );
  unknownKeys(
    report.corpus,
    new Set([
      'manifestPath',
      'manifestSha256',
      'scale',
      'profile',
      'artifacts',
      'bytes',
      'chunks',
      'tables',
    ]),
    'corpus',
    problems,
  );
  unknownKeys(
    report.workload,
    new Set(['path', 'sha256', 'queryCount', 'contextTaskCount', 'tableQueryCount']),
    'workload',
    problems,
  );
  unknownKeys(report.samples, new Set(['warmup', 'repetitions', 'timeoutMs']), 'samples', problems);
  unknownKeys(report.measurements, new Set(['phases']), 'measurements', problems);
  unknownKeys(
    report.quality,
    new Set(['search', 'provenance', 'context', 'answer']),
    'quality',
    problems,
  );
  validateAnswerQuality(report.quality?.answer, problems);
  validateCostAccounting(report.costAccounting, problems);
  unknownKeys(
    report.resources,
    new Set(['indexBytes', 'peakRssMiB', 'topK']),
    'resources',
    problems,
  );
  unknownKeys(
    report.configuration,
    new Set([
      'tokenizer',
      'ranking',
      'columns',
      'normalization',
      'sourceBoundary',
      'pipeline',
      'retriever',
      'chunking',
      'topK',
      'contextBudgetTokens',
      'promptTemplate',
      'mode',
      'provider',
      'model',
      'embeddingModel',
      'temperature',
    ]),
    'configuration',
    problems,
  );

  if (report.protocol?.name !== 'lorepack-benchmark')
    problems.push('protocol.name must be lorepack-benchmark');
  if (report.protocol?.version !== BENCHMARK_PROTOCOL_VERSION) {
    problems.push(`protocol.version must be ${BENCHMARK_PROTOCOL_VERSION}`);
  }
  for (const path of [
    'reportId',
    'generatedAt',
    'commitSha',
    'implementation.name',
    'implementation.version',
    'environment.platform',
    'environment.arch',
    'environment.runner',
    'environment.node',
    'environment.cpu',
    'environment.storageClass',
    'corpus.manifestPath',
    'corpus.scale',
    'corpus.profile',
    'workload.path',
    'workload.queryCount',
    'workload.contextTaskCount',
    'samples.warmup',
    'samples.repetitions',
    'measurements.phases',
    'claims',
  ]) {
    const value = path.split('.').reduce((current, key) => current?.[key], report);
    required(value, path, problems);
  }

  commitDigest(report.commitSha, 'commitSha', problems);
  if (typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) {
    problems.push('generatedAt must be an ISO date-time');
  }
  digest(report.corpus?.manifestSha256, 'corpus.manifestSha256', problems);
  digest(report.workload?.sha256, 'workload.sha256', problems);
  for (const path of ['corpus.artifacts', 'corpus.bytes', 'corpus.chunks', 'corpus.tables']) {
    nonNegative(
      path.split('.').reduce((current, key) => current?.[key], report),
      path,
      problems,
    );
  }
  for (const path of [
    'workload.queryCount',
    'workload.contextTaskCount',
    'workload.tableQueryCount',
    'samples.warmup',
    'samples.repetitions',
    'samples.timeoutMs',
  ]) {
    nonNegative(
      path.split('.').reduce((current, key) => current?.[key], report),
      path,
      problems,
    );
  }
  if (report.samples?.repetitions === 0)
    problems.push('samples.repetitions must be greater than zero');

  if (!Array.isArray(report.measurements?.phases)) {
    problems.push('measurements.phases must be an array');
  } else {
    report.measurements.phases.forEach((phase, index) => {
      validatePhase(phase, index, problems);
    });
  }
  validateTokens(report.tokenAccounting, problems);

  if (!Array.isArray(report.claims)) {
    problems.push('claims must be an array');
  } else {
    report.claims.forEach((claim, index) => {
      const path = `claims[${index}]`;
      unknownKeys(claim, new Set(['id', 'status', 'statement', 'evidence']), path, problems);
      required(claim?.id, `${path}.id`, problems);
      required(claim?.statement, `${path}.statement`, problems);
      if (!CLAIM_STATUSES.has(claim?.status)) problems.push(`${path}.status is invalid`);
      if (
        claim?.status === 'measured' &&
        (!Array.isArray(claim.evidence) || claim.evidence.length === 0)
      ) {
        problems.push(`${path}.evidence is required for a measured claim`);
      }
    });
  }

  return problems;
}

export function readAndValidateBenchmarkReport(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const problems = validateBenchmarkReport(report);
  return { report, problems };
}

if (process.argv[1]?.endsWith('benchmark-report.mjs')) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('Usage: node scripts/benchmark-report.mjs <report.json>');
    process.exit(2);
  }
  const { problems } = readAndValidateBenchmarkReport(path);
  if (problems.length > 0) {
    console.error(`Benchmark protocol validation failed for ${path}.`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Benchmark protocol v${BENCHMARK_PROTOCOL_VERSION}: ${path} is valid`);
}
