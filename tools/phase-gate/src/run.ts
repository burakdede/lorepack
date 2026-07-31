import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Criterion, CriterionResult, Outcome, PhaseDefinition, PhaseReport } from './types.js';

const run = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 600_000;

export interface RunOptions {
  readonly repoRoot: string;
  /** Injected so the meta-tests can exercise every branch without a network. */
  readonly execute?: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}

async function defaultExecute(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(command, [...args], { cwd, timeout: timeoutMs });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? String(error),
    };
  }
}

async function checkCommand(
  criterion: Extract<Criterion, { kind: 'command' }>,
  options: RunOptions,
): Promise<CriterionResult> {
  const execute = options.execute ?? defaultExecute;
  const printable = `${criterion.command} ${criterion.args.join(' ')}`.trim();
  const result = await execute(
    criterion.command,
    criterion.args,
    criterion.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.repoRoot,
  );
  const base = { id: criterion.id, promise: criterion.promise, evidence: `ran \`${printable}\`` };
  if (result.code === 0) return { ...base, outcome: 'passed' };
  return {
    ...base,
    outcome: 'failed',
    detail: (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n'),
  };
}

async function checkExports(
  criterion: Extract<Criterion, { kind: 'exports' }>,
  options: RunOptions,
): Promise<CriterionResult> {
  const specifier = join(options.repoRoot, criterion.module);
  const base = {
    id: criterion.id,
    promise: criterion.promise,
    evidence: `${criterion.symbols.length} symbols from ${criterion.module}`,
  };

  if (options.importModule === undefined && !existsSync(specifier)) {
    return {
      ...base,
      outcome: 'failed',
      detail: `${criterion.module} does not exist. Run \`pnpm build\` first if this is a dist path.`,
    };
  }

  let module: Record<string, unknown>;
  try {
    module =
      options.importModule === undefined
        ? ((await import(pathToFileURL(specifier).href)) as Record<string, unknown>)
        : await options.importModule(criterion.module);
  } catch (error) {
    return { ...base, outcome: 'failed', detail: `could not import: ${String(error)}` };
  }

  const missing = criterion.symbols.filter((symbol) => !(symbol in module));
  if (missing.length === 0) return { ...base, outcome: 'passed' };
  return { ...base, outcome: 'failed', detail: `missing exports: ${missing.join(', ')}` };
}

function checkPath(
  criterion: Extract<Criterion, { kind: 'path' }>,
  options: RunOptions,
): CriterionResult {
  const missing = criterion.paths.filter((path) => !existsSync(join(options.repoRoot, path)));
  const base = {
    id: criterion.id,
    promise: criterion.promise,
    evidence: `${criterion.paths.length} paths`,
  };
  if (missing.length === 0) return { ...base, outcome: 'passed' };
  return { ...base, outcome: 'failed', detail: `missing: ${missing.join(', ')}` };
}

/**
 * Issue state needs network and GitHub authentication. When either is absent this reports
 * `unverified` and says why. It must never report `passed`: a gate that succeeds when it
 * could not check is worse than no gate at all.
 */
async function checkIssues(
  criterion: Extract<Criterion, { kind: 'issues' }>,
  options: RunOptions,
): Promise<CriterionResult> {
  const execute = options.execute ?? defaultExecute;
  const base = {
    id: criterion.id,
    promise: criterion.promise,
    evidence: `milestone "${criterion.milestone}" via gh`,
  };
  const result = await execute(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      'burakdede/lorepack',
      '--state',
      'open',
      '--milestone',
      criterion.milestone,
      '--limit',
      '200',
      '--json',
      'number,title',
    ],
    60_000,
    options.repoRoot,
  );

  if (result.code !== 0) {
    return {
      ...base,
      outcome: 'unverified',
      detail: `gh unavailable or unauthenticated, so issue state could not be checked: ${
        (result.stderr || 'no output').trim().split('\n')[0]
      }`,
    };
  }

  let open: Array<{ number: number; title: string }>;
  try {
    open = JSON.parse(result.stdout || '[]') as Array<{ number: number; title: string }>;
  } catch {
    return { ...base, outcome: 'unverified', detail: 'gh returned output that is not JSON' };
  }

  const allowed = new Set(criterion.allowOpen ?? []);
  const unexpected = open.filter((issue) => !allowed.has(issue.number));
  if (unexpected.length === 0) return { ...base, outcome: 'passed' };
  return {
    ...base,
    outcome: 'failed',
    detail: `still open: ${unexpected.map((i) => `#${i.number} ${i.title}`).join('; ')}`,
  };
}

export async function checkCriterion(
  criterion: Criterion,
  options: RunOptions,
): Promise<CriterionResult> {
  switch (criterion.kind) {
    case 'command':
      return checkCommand(criterion, options);
    case 'exports':
      return checkExports(criterion, options);
    case 'path':
      return checkPath(criterion, options);
    case 'issues':
      return checkIssues(criterion, options);
  }
}

export async function checkPhase(
  definition: PhaseDefinition,
  options: RunOptions,
): Promise<PhaseReport> {
  const results: CriterionResult[] = [];
  for (const criterion of definition.criteria) {
    results.push(await checkCriterion(criterion, options));
  }

  const counts = {
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    unverified: results.filter((r) => r.outcome === 'unverified').length,
  };
  const outcome: Outcome =
    counts.failed > 0 ? 'failed' : counts.unverified > 0 ? 'unverified' : 'passed';

  return {
    phase: definition.phase,
    title: definition.title,
    epic: definition.epic,
    outcome,
    results,
    counts,
  };
}

const MARK: Record<Outcome, string> = { passed: 'pass', failed: 'FAIL', unverified: '????' };

export function formatReport(report: PhaseReport): string {
  const lines = [`Phase ${report.phase}: ${report.title} (epic #${report.epic})`, ''];
  for (const result of report.results) {
    lines.push(`  ${MARK[result.outcome]}  ${result.id}`);
    lines.push(`        ${result.promise}`);
    lines.push(`        checked: ${result.evidence}`);
    if (result.detail !== undefined) {
      for (const line of result.detail.split('\n')) lines.push(`        ${line}`);
    }
    lines.push('');
  }
  lines.push(
    `${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.unverified} unverified`,
  );
  if (report.outcome === 'unverified') {
    lines.push('');
    lines.push('An unverified criterion is not a pass. The gate could not check it.');
  }
  return lines.join('\n');
}
