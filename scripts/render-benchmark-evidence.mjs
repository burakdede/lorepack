#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateBenchmarkReport } from './benchmark-report.mjs';

const inputDirectory = process.argv[2];
if (inputDirectory === undefined) {
  console.error(
    'Usage: node scripts/render-benchmark-evidence.mjs <artifact-directory> [--json <path>] [--markdown <path>]',
  );
  process.exit(2);
}

const root = resolve(inputDirectory);
const jsonOutput = optionPath('--json');
const markdownOutput = optionPath('--markdown');

function optionPath(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function jsonFiles(directory, current = directory) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return jsonFiles(directory, path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

function fail(message) {
  throw new Error(message);
}

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function source(path, pointer) {
  return { artifact: relative(root, path), pointer };
}

function phase(report, name) {
  return report.measurements?.phases?.find((entry) => entry.name === name) ?? null;
}

function qualityRatio(value, cases) {
  return typeof value === 'number' ? value / cases : value;
}

function reportIdentity(report) {
  return {
    commitSha: report.commitSha,
    manifestSha256: report.corpus?.manifestSha256,
    workloadSha256: report.workload?.sha256,
    scale: report.corpus?.scale,
    profile: report.corpus?.profile,
  };
}

function collectReports(files) {
  const reports = [];
  for (const path of files) {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (document.protocol?.name === 'lorepack-benchmark') {
      const problems = validateBenchmarkReport(document);
      if (problems.length > 0) fail(`${relative(root, path)}:\n${problems.join('\n')}`);
      reports.push({ report: document, path, pointer: '' });
      continue;
    }
    if (document.protocol?.name === 'lorepack-benchmark-comparison') {
      for (const [name, report] of Object.entries(document.protocolReports ?? {})) {
        const problems = validateBenchmarkReport(report);
        if (problems.length > 0) fail(`${relative(root, path)}.${name}:\n${problems.join('\n')}`);
        reports.push({
          report,
          path,
          pointer: `/protocolReports/${pointerSegment(name)}`,
        });
      }
      continue;
    }
    if (document.protocol?.name === 'lorepack-usefulness-metrics') {
      if (document.protocol.version !== 1)
        fail(`${relative(root, path)} has an unknown usefulness protocol version`);
      reports.push({ report: document, path, pointer: '' });
      continue;
    }
    if (
      document.protocol?.name !== 'lorepack-benchmark-evidence' &&
      document.protocol?.name !== 'lorepack-research-pruning'
    )
      fail(`${relative(root, path)} is not a supported benchmark artifact`);
  }
  if (reports.length === 0) fail('No supported benchmark reports were found');
  return reports;
}

function claim({
  id,
  statement,
  status,
  metric,
  evidencePointer,
  denominator,
  value,
  units,
  report,
  path,
  pointer,
  owner,
}) {
  return {
    id,
    statement,
    status,
    metric,
    denominator,
    value,
    units,
    owner,
    expiresOn: null,
    retestWhen:
      'When the corpus, workload, ranking implementation, Node version or runner policy changes.',
    evidence: [source(path, `${pointer}${evidencePointer ?? `/${metric}`}`)],
    runner: report.environment?.runner ?? 'local',
    platform: report.environment?.platform ?? report.machine?.platform ?? null,
    runnerArchitecture: report.environment?.arch ?? report.machine?.arch ?? null,
  };
}

function buildEvidence(reports) {
  const implementationReports = reports.filter(
    ({ report }) => report.protocol?.name === 'lorepack-benchmark',
  );
  const identities = new Map();
  for (const item of implementationReports) {
    const identity = JSON.stringify(reportIdentity(item.report));
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  if (identities.size !== 1)
    fail('Benchmark reports do not share one commit, corpus, workload and profile identity');

  const comparison = reports.filter(
    ({ report }) =>
      report.implementation?.name === 'lorepack-runtime' ||
      report.implementation?.name === 'sqlite-fts5-direct',
  );
  const lorepack = comparison.find(
    ({ report }) => report.implementation.name === 'lorepack-runtime',
  );
  const fts5 = comparison.find(({ report }) => report.implementation.name === 'sqlite-fts5-direct');
  const rag = reports.find(({ report }) => report.implementation?.name === 'rag-offline-lexical');
  const usefulness = reports.find(
    ({ report }) => report.protocol?.name === 'lorepack-usefulness-metrics',
  );
  if (!lorepack || !fts5 || !rag || !usefulness)
    fail('Evidence report requires Lorepack, direct FTS5, offline RAG and usefulness reports');

  const lorepackWarm = phase(lorepack.report, 'warm-query');
  const fts5Warm = phase(fts5.report, 'warm-query');
  const ragWarm = phase(rag.report, 'warm-query');
  const lorepackContext = phase(lorepack.report, 'context-assembly');
  const ragContext = phase(rag.report, 'context-assembly');
  const lorepackSearch = lorepack.report.quality.search;
  const fts5Search = fts5.report.quality.search;
  const ragSearch = rag.report.quality.search;

  const identity = lorepack.reportIdentity ?? reportIdentity(lorepack.report);
  const claims = [
    claim({
      id: 'lorepack-provenance',
      statement: 'Lorepack returns provenance-bearing search hits and context citations.',
      status: 'quality-result',
      metric: 'quality.provenance.coverage',
      evidencePointer: '/quality/provenance/coverage',
      denominator: 'All search hits and context citations emitted by the Lorepack report',
      value: lorepack.report.quality.provenance.coverage,
      units: 'ratio',
      report: lorepack.report,
      path: lorepack.path,
      pointer: lorepack.pointer,
      owner: 'Lorepack maintainers',
    }),
    claim({
      id: 'lorepack-labelled-retrieval',
      statement:
        'Lorepack reached the expected location at rank 1 for the labelled workload used here.',
      status: 'quality-result',
      metric: 'quality.search.hitAt1',
      evidencePointer: '/quality/search/hitAt1',
      denominator: `${lorepackSearch.cases} labelled retrieval cases`,
      value: lorepackSearch.hitAt1,
      units: 'ratio',
      report: lorepack.report,
      path: lorepack.path,
      pointer: lorepack.pointer,
      owner: 'Lorepack maintainers',
    }),
    claim({
      id: 'direct-fts5-latency',
      statement: 'Direct SQLite FTS5 was faster for warm lexical lookup on this corpus and runner.',
      status: 'measured',
      metric: 'measurements.phases[name=warm-query].p95Ms',
      evidencePointer: `/measurements/phases/${fts5.report.measurements.phases.indexOf(fts5Warm)}/p95Ms`,
      denominator: `${fts5Warm.samples} warm-query samples on the shared workload`,
      value: fts5Warm.p95Ms,
      units: 'milliseconds',
      report: fts5.report,
      path: fts5.path,
      pointer: fts5.pointer,
      owner: 'Lorepack maintainers',
    }),
    claim({
      id: 'lorepack-context-lifecycle',
      statement: 'Lorepack measures bounded context assembly as a runtime lifecycle phase.',
      status: 'measured',
      metric: 'measurements.phases[name=context-assembly].p95Ms',
      evidencePointer: `/measurements/phases/${lorepack.report.measurements.phases.indexOf(lorepackContext)}/p95Ms`,
      denominator: `${lorepackContext.samples} context-assembly samples`,
      value: lorepackContext.p95Ms,
      units: 'milliseconds',
      report: lorepack.report,
      path: lorepack.path,
      pointer: lorepack.pointer,
      owner: 'Lorepack maintainers',
    }),
    claim({
      id: 'offline-rag-answer-quality',
      statement: 'The offline RAG baseline does not measure model answer quality.',
      status: 'not-measured',
      metric: 'quality.answer.status',
      evidencePointer: '/quality/answer/status',
      denominator: `${rag.report.quality.answer.cases} prompt cases`,
      value: rag.report.quality.answer.status,
      units: 'status',
      report: rag.report,
      path: rag.path,
      pointer: rag.pointer,
      owner: 'Lorepack maintainers',
    }),
    claim({
      id: 'lorepack-rollback',
      statement:
        'Lorepack restored the previous active build by pointer change without rebuilding it.',
      status: 'measured',
      metric: 'metrics.rollback',
      evidencePointer: '/metrics/rollback',
      denominator: 'One rollback scenario in the usefulness fixture',
      value: {
        pointerChangeMs: usefulness.report.metrics.rollback.pointerChangeMs,
        restored: usefulness.report.metrics.rollback.restored,
        rebuiltBuilds: usefulness.report.metrics.rollback.rebuiltBuilds,
      },
      units: 'milliseconds and boolean evidence',
      report: usefulness.report,
      path: usefulness.path,
      pointer: usefulness.pointer,
      owner: 'Lorepack maintainers',
    }),
  ];

  const maxGeneratedAt = reports
    .map(({ report }) => report.generatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    protocol: { name: 'lorepack-benchmark-evidence', version: 1 },
    generatedAt: maxGeneratedAt ?? null,
    identity,
    corpus: lorepack.report.corpus,
    workload: lorepack.report.workload,
    sourceReports: reports.map(({ report, path, pointer }) => ({
      implementation: report.implementation?.name ?? report.protocol?.name,
      artifact: relative(root, path),
      pointer,
      runner: report.environment?.runner ?? 'local',
      platform: report.environment?.platform ?? report.machine?.platform ?? null,
      arch: report.environment?.arch ?? report.machine?.arch ?? null,
    })),
    comparison: {
      lorepack: {
        warmQueryP95Ms: lorepackWarm.p95Ms,
        buildP95Ms: phase(lorepack.report, 'build')?.p95Ms ?? null,
        contextAssemblyP95Ms: lorepackContext.p95Ms,
        hitAt1: lorepackSearch.hitAt1,
        expectedLocationCoverage: lorepackSearch.expectedLocationCoverage ?? null,
      },
      sqliteFts5: {
        warmQueryP95Ms: fts5Warm.p95Ms,
        indexBuildP95Ms: phase(fts5.report, 'index-build')?.p95Ms ?? null,
        contextAssembly: 'not-measured',
        hitAt1: fts5Search.hitAt1,
        expectedLocationCoverage: fts5Search.expectedLocationCoverage ?? null,
      },
      offlineRag: {
        warmQueryP95Ms: ragWarm.p95Ms,
        contextAssemblyP95Ms: ragContext.p95Ms,
        promptConstructionP95Ms: phase(rag.report, 'prompt-construction')?.p95Ms ?? null,
        hitAt1: qualityRatio(ragSearch.hitAt1, ragSearch.cases),
        answerQuality: rag.report.quality.answer.status,
        tokenAccounting: rag.report.tokenAccounting,
      },
    },
    usefulness: {
      provenance: usefulness.report.metrics.provenance,
      contextBudget: usefulness.report.metrics.contextBudget,
      changeReview: usefulness.report.metrics.changeReview,
      rollback: usefulness.report.metrics.rollback,
      buildReuse: usefulness.report.metrics.buildReuse,
    },
    claims,
    limitations: [
      'The checked-in corpus is repository-owned and synthetic in part. It is not an industry benchmark.',
      'The workload is small and labelled for regression evidence, not a universal relevance test.',
      'The direct FTS5 and offline RAG baselines share Lorepack-normalized chunks, so their index measurements exclude parsing and chunking.',
      'The offline RAG report estimates tokens and does not call a model. Hosted model quality and cost are provider-dependent.',
      'These reports do not establish semantic superiority, factual correctness or lower total system cost.',
    ],
    reproducibility: {
      commands: [
        'pnpm install --frozen-lockfile',
        'pnpm build',
        'LORE_BENCH_PACKS=1 LORE_BENCH_SCALE=small LORE_BENCH_PROFILE=mixed node scripts/bench-retrieval-comparison.mjs --out comparison.json',
        'LORE_BENCH_PACKS=1 LORE_BENCH_SCALE=small LORE_BENCH_PROFILE=mixed node scripts/bench-rag.mjs --out rag.json',
        'LORE_BENCH_PACKS=1 LORE_BENCH_SCALE=small LORE_BENCH_PROFILE=mixed node scripts/bench-usefulness.mjs --out usefulness.json',
        'node scripts/render-benchmark-evidence.mjs <artifact-directory> --json evidence.json --markdown evidence.md',
      ],
      credentialsRequired: false,
    },
  };
}

function markdownReport(evidence) {
  const { comparison, usefulness } = evidence;
  const rows = [
    [
      'Lorepack runtime',
      comparison.lorepack.buildP95Ms,
      comparison.lorepack.warmQueryP95Ms,
      comparison.lorepack.contextAssemblyP95Ms,
      comparison.lorepack.hitAt1,
    ],
    [
      'Direct SQLite FTS5',
      comparison.sqliteFts5.indexBuildP95Ms,
      comparison.sqliteFts5.warmQueryP95Ms,
      'not measured',
      comparison.sqliteFts5.hitAt1,
    ],
    [
      'Offline lexical RAG',
      'not applicable',
      comparison.offlineRag.warmQueryP95Ms,
      comparison.offlineRag.contextAssemblyP95Ms,
      comparison.offlineRag.hitAt1,
    ],
  ];
  return [
    '# Benchmark evidence report',
    '',
    `Protocol: \`${evidence.protocol.name} v${evidence.protocol.version}\``,
    `Corpus: \`${evidence.identity.manifestSha256}\``,
    `Workload: \`${evidence.identity.workloadSha256}\``,
    `Scale: \`${evidence.identity.scale}\`, profile: \`${evidence.identity.profile}\``,
    '',
    'This report describes what was measured on the identified corpus and runner. It does not claim a universal winner.',
    '',
    '| Implementation | Build or index p95 (ms) | Warm query p95 (ms) | Context p95 (ms) | Labelled hit@1 |',
    '|---|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} | ${row[4]} |`),
    '',
    '## What Lorepack provides',
    '',
    `- Provenance coverage: ${usefulness.provenance.search.ratio} for search, ${usefulness.provenance.context.ratio} for context, and ${usefulness.provenance.tableRows.ratio} for table rows in the usefulness fixture.`,
    `- Rollback evidence: ${usefulness.rollback.pointerChangeMs} ms pointer change, restored: ${usefulness.rollback.restored}, rebuilt builds: ${usefulness.rollback.rebuiltBuilds}.`,
    `- The direct FTS5 baseline is faster for warm lexical lookup here, and it does not implement Lorepack's bounded context, build identity or rollback contract.`,
    '',
    '## Claims and limitations',
    '',
    ...evidence.limitations.map((limitation) => `- ${limitation}`),
    '',
    'Every number in this report is linked to a JSON pointer in `claims`. Use the raw artifacts and reproduction commands in the machine-readable report for independent review.',
    '',
  ].join('\n');
}

const reports = collectReports(jsonFiles(root));
const evidence = buildEvidence(reports);
const markdown = markdownReport(evidence);
if (jsonOutput) writeFileSync(jsonOutput, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
if (markdownOutput) writeFileSync(markdownOutput, markdown, 'utf8');
console.log(markdown);
