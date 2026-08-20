#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.LOREPACK_ROOT ?? join(import.meta.dirname, '..');

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const readText = (path) => readFileSync(join(ROOT, path), 'utf8');

const RELEASE = 'benchmarks/releases/v0.1.json';
const REPORT = 'docs/compatibility/performance-v0.1.md';
const ARCH = 'Lorepack_Local_First_MVP_Architecture_Final.md';

const problems = [];

for (const path of [RELEASE, REPORT]) {
  if (!existsSync(join(ROOT, path))) problems.push(`${path} is missing`);
}

if (problems.length === 0) {
  const release = readJson(RELEASE);
  const report = readText(REPORT);
  const arch = readText(ARCH);

  const phase1 = readJson('benchmarks/phase-1-dev-machine.json');
  const retrieval = readJson('benchmarks/retrieval/phase-2-envelope-dev-machine.json');
  const envelope = readJson('benchmarks/envelope/reference-2026-08-05.json');
  const byteEnvelope = readJson('benchmarks/envelope/byte-envelope-2026-08-14.json');

  if (byteEnvelope.machine?.storage !== 'local APFS SSD') {
    problems.push('byte-envelope benchmark must record the storage class');
  }

  const expected = new Map([
    ['fingerprint-file-envelope', envelope.measurements.noopRebuildP95Ms],
    ['fingerprint-byte-envelope', byteEnvelope.measurements.noopRebuildP95Ms],
    ['warm-lexical-search', retrieval.measurements.warmSearchP95Ms],
    ['context-for-task', retrieval.measurements.contextBundleP95Ms],
    ['lifecycle-incremental-rebuild', phase1.measurements.incrementalBuildMs],
    ['envelope-incremental-rebuild', envelope.measurements.incrementalRebuildP95Ms],
  ]);

  const gates = new Map(release.gates.map((gate) => [gate.id, gate]));
  for (const [id, p95] of expected) {
    const gate = gates.get(id);
    if (gate === undefined) {
      problems.push(`${RELEASE} is missing gate ${id}`);
      continue;
    }
    if (gate.p95Ms !== p95) {
      problems.push(`${id} p95 is ${gate.p95Ms}, expected ${p95}`);
    }
    if (!report.includes(id)) problems.push(`${REPORT} does not mention ${id}`);
    if (!report.includes(gate.evidence)) {
      problems.push(`${REPORT} does not link ${gate.evidence}`);
    }
  }

  for (const gate of release.gates) {
    if (
      gate.status === 'pass' &&
      typeof gate.targetP95Ms === 'number' &&
      gate.p95Ms > gate.targetP95Ms
    ) {
      problems.push(`${gate.id} misses its p95 target`);
    }
    if (gate.status === 'reported-only' && gate.targetP95Ms !== null) {
      problems.push(`${gate.id} is reported-only but still has a target`);
    }
  }

  if (byteEnvelope.envelopeIncrementalRebuildPolicy !== 'reported-only') {
    problems.push('byte-envelope report must keep envelope incremental rebuild reported-only');
  }

  for (const path of [
    'benchmarks/phase-1-dev-machine.json',
    'benchmarks/retrieval/phase-2-envelope-dev-machine.json',
    'benchmarks/envelope/reference-2026-08-05.json',
    'benchmarks/envelope/byte-envelope-2026-08-14.json',
  ]) {
    if (!report.includes(path)) problems.push(`${REPORT} does not cite ${path}`);
  }

  for (const phrase of [
    'packages/core/test/progress.test.ts',
    'packages/cli/test/build.test.ts',
    'tools/acceptance/src/scenarios/cancellation.ts',
  ]) {
    if (!report.includes(phrase)) problems.push(`${REPORT} lacks behavioural evidence ${phrase}`);
  }

  const removedClaims = [
    /full 1 GB\s*\/\s*2,500-file envelope:\s*p95 below 4 s/i,
    /1 GiB byte envelope[^.\n]*p95 below 4 s/i,
    /1 GB byte envelope[^.\n]*p95 below 4 s/i,
  ];
  for (const pattern of removedClaims) {
    if (pattern.test(arch) || pattern.test(report)) {
      problems.push('documentation reintroduced the removed 1 GiB fingerprint p95 claim');
    }
  }

  if (!report.includes('#302')) {
    problems.push(`${REPORT} must link the byte-envelope fingerprint follow-up issue #302`);
  }
}

if (problems.length > 0) {
  console.error('check:performance-report failed.\n');
  for (const problem of problems.sort((a, b) => a.localeCompare(b))) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log('check:performance-report: v0.1 claims match committed measurements');
