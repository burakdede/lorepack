import { execFile, spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { stageInstall } from './install.js';
import type { Expect, JsonExpect, Scenario, Step, TextExpect } from './types.js';

const execute = promisify(execFile);

export interface RunnerOptions {
  /** Absolute path to the built `lore` entry point. */
  readonly binary: string;
  /** Kept temp directory, for debugging a failure by hand. */
  readonly keepOnFailure?: boolean;
}

export interface ScenarioReport {
  readonly id: string;
  readonly failures: readonly string[];
  readonly skipped: readonly string[];
  readonly root: string;
}

interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Snapshot {
  readonly builds: readonly string[];
  readonly active: string | null;
}

/**
 * Runs one scenario in a randomised temporary directory.
 *
 * Failures are collected rather than thrown, so a scenario reports everything that went
 * wrong in one run instead of hiding later problems behind the first one.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunnerOptions,
): Promise<ScenarioReport> {
  const root = mkdtempSync(join(tmpdir(), 'lore-acceptance-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });

  const failures: string[] = [];
  const skipped: string[] = [];
  const captures = new Map<string, string>();
  const snapshots = new Map<string, Snapshot>();

  // An installed scenario drives a staged copy of the published files instead of the
  // working tree, so the binary under test differs for the whole scenario, setup included.
  const binary =
    scenario.runFrom === 'installed'
      ? stageInstall(repoRootOf(options.binary), join(root, 'installed')).binary
      : options.binary;

  const lore = async (cwd: string, args: readonly string[]): Promise<Executed> => {
    try {
      const { stdout, stderr } = await execute(process.execPath, [binary, '--cwd', cwd, ...args], {
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  };

  const snapshot = async (): Promise<Snapshot> => {
    let builds: string[] = [];
    try {
      builds = readdirSync(join(project, '.lore', 'builds')).sort();
    } catch {
      builds = [];
    }
    const listed = await lore(project, ['--json', 'builds']);
    let active: string | null = null;
    try {
      const parsed = JSON.parse(listed.stdout) as {
        builds?: Array<{ buildId: string; active?: boolean }>;
      };
      active = parsed.builds?.find((entry) => entry.active === true)?.buildId ?? null;
    } catch {
      active = null;
    }
    return { builds, active };
  };

  try {
    materialise(project, scenario);

    for (const step of scenario.fixture.setup ?? []) {
      const args =
        step === 'init'
          ? ['init']
          : step === 'build'
            ? ['build']
            : ['build', '--allow-large-project'];
      const result = await lore(project, args);
      if (result.code !== 0) {
        failures.push(`setup \`lore ${args.join(' ')}\` exited ${result.code}\n${result.stderr}`);
        return { id: scenario.id, failures, skipped, root };
      }
    }

    for (const [index, step] of scenario.steps.entries()) {
      const where = `step ${index + 1} (${step.action})`;
      const problems = await runStep(step, {
        where,
        root,
        project,
        outside,
        lore,
        captures,
        snapshots,
        snapshot,
        binary,
        skipped,
      });
      failures.push(...problems);
    }
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (failures.length === 0 || options.keepOnFailure !== true) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Windows may hold a handle briefly. A leaked temp directory must not fail a run.
      }
    }
  }

  return { id: scenario.id, failures, skipped, root };
}

interface StepContext {
  readonly where: string;
  readonly root: string;
  readonly project: string;
  readonly outside: string;
  readonly binary: string;
  readonly lore: (cwd: string, args: readonly string[]) => Promise<Executed>;
  readonly captures: Map<string, string>;
  readonly snapshots: Map<string, Snapshot>;
  readonly snapshot: () => Promise<Snapshot>;
  readonly skipped: string[];
}

async function runStep(step: Step, context: StepContext): Promise<string[]> {
  switch (step.action) {
    case 'run':
    case 'run-in': {
      const cwd = step.action === 'run' ? context.project : join(context.root, step.project);
      const args = step.json === true ? ['--json', ...step.args] : [...step.args];
      const result = await context.lore(
        cwd,
        args.map((arg) => fill(arg, context.captures)),
      );
      const problems = check(result, step.expect, context);
      if (step.capture !== undefined) {
        problems.push(...capture(result, step.capture, context));
      }
      return problems.map((problem) => `${context.where} \`lore ${args.join(' ')}\`: ${problem}`);
    }

    case 'write': {
      const target = resolveInProject(context.project, fill(step.path, context.captures));
      mkdirSync(dirname(target), { recursive: true });
      if (step.atomic === true) {
        const temporary = `${target}.editor-tmp`;
        writeFileSync(temporary, step.contents, 'utf8');
        renameSync(temporary, target);
      } else {
        writeFileSync(target, step.contents, 'utf8');
      }
      return [];
    }

    case 'empty-sources': {
      for (const file of sourceFiles(context.project)) writeFileSync(file, '', 'utf8');
      return [];
    }

    case 'symlink': {
      const target = join(context.outside, step.outsideFile.name);
      writeFileSync(target, step.outsideFile.contents, 'utf8');
      const link = join(context.project, ...step.path.split('/'));
      mkdirSync(dirname(link), { recursive: true });
      try {
        symlinkSync(context.outside, link, 'dir');
      } catch (error) {
        // Unprivileged Windows cannot create directory symlinks. That is an environment
        // limit, not a product defect, so it is reported as a skip rather than a failure.
        context.skipped.push(
          `${context.where}: symlink unsupported here (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return [];
    }

    case 'clone': {
      const destination = join(context.root, step.as);
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(context.project)) {
        if (entry === '.lore' || entry === 'lore.lock') continue;
        cpSync(join(context.project, entry), join(destination, entry), {
          recursive: true,
          // A symlink in the tree is the subject of another scenario, never of this one.
          dereference: false,
        });
      }
      return [];
    }

    case 'corrupt': {
      const target = resolveInProject(context.project, fill(step.path, context.captures));
      // Every bit flipped rather than a byte zeroed: writing 0x00 over a byte that is
      // already 0x00 corrupts nothing and would make the scenario pass for the wrong reason.
      const handle = openSync(target, 'r+');
      try {
        const byte = Buffer.alloc(1);
        readSync(handle, byte, 0, 1, step.offset);
        byte[0] = (byte[0] ?? 0) ^ 0xff;
        writeSync(handle, byte, 0, 1, step.offset);
      } finally {
        closeQuietly(handle);
      }
      return [];
    }

    case 'external': {
      const args = step.args.map((arg) => fill(arg, context.captures));
      const result = await runExternal(step.command, args, context);
      if (result === null) {
        if (step.whenMissing === 'skip') {
          context.skipped.push(`${context.where}: ${step.command} is not installed here`);
          return [];
        }
        return [`${context.where}: ${step.command} is not installed`];
      }
      return check(result, step.expect, context).map(
        (problem) => `${context.where} \`${step.command}\`: ${problem}`,
      );
    }

    case 'interrupt': {
      const result = await interrupt(
        step.args,
        step.signal,
        step.afterMs,
        step.repeat ?? 1,
        context,
        step.afterOutput,
      );
      return check(result, step.expect, context).map(
        (problem) => `${context.where} interrupted \`lore ${step.args.join(' ')}\`: ${problem}`,
      );
    }

    case 'concurrent': {
      const background = start(step.background, context);
      await delay(step.afterMs);
      const result = await context.lore(context.project, step.foreground);
      const problems = check(result, step.expect, context);
      const first = await background;
      if (first.code !== 0) {
        problems.push(`the background command exited ${first.code}\n${first.stderr}`);
      }
      return problems.map(
        (problem) => `${context.where} \`lore ${step.foreground.join(' ')}\`: ${problem}`,
      );
    }

    case 'identical': {
      const read = (reference: { project?: string; path: string }): Buffer => {
        const base =
          reference.project === undefined ? context.project : join(context.root, reference.project);
        return readFileSync(resolveInProject(base, fill(reference.path, context.captures)));
      };
      let left: Buffer;
      let right: Buffer;
      try {
        left = read(step.left);
        right = read(step.right);
      } catch (error) {
        return [`${context.where}: ${error instanceof Error ? error.message : String(error)}`];
      }
      if (step.as === 'bytes') {
        return left.equals(right)
          ? []
          : [
              `${context.where}: ${step.left.path} and ${step.right.path} differ (${left.length} vs ${right.length} bytes)`,
            ];
      }
      const parse = (buffer: Buffer): string =>
        JSON.stringify(sortKeys(JSON.parse(buffer.toString())));
      try {
        return parse(left) === parse(right)
          ? []
          : [
              `${context.where}: ${step.left.path} and ${step.right.path} describe different builds`,
            ];
      } catch (error) {
        return [
          `${context.where}: not JSON (${error instanceof Error ? error.message : String(error)})`,
        ];
      }
    }

    case 'record': {
      context.snapshots.set(step.name, await context.snapshot());
      return [];
    }

    case 'unchanged': {
      const before = context.snapshots.get(step.name);
      if (before === undefined) return [`${context.where}: no snapshot named ${step.name}`];
      const after = await context.snapshot();
      const problems: string[] = [];
      if (before.builds.join(',') !== after.builds.join(',')) {
        problems.push(
          `builds/ changed: ${before.builds.length} -> ${after.builds.length} (${after.builds
            .filter((id) => !before.builds.includes(id))
            .join(', ')} appeared)`,
        );
      }
      if (before.active !== after.active) {
        problems.push(`active pointer moved: ${before.active} -> ${after.active}`);
      }
      return problems.map((problem) => `${context.where}: ${problem}`);
    }

    case 'note':
      // Manual scenarios are rendered, never executed. Reaching here means a manual step
      // ended up in an automated scenario, which the catalogue test also rejects.
      return [`${context.where}: a note step cannot be executed`];
  }
}

/**
 * Starts the binary, waits for the stage under test, and sends a real signal to the real
 * process.
 *
 * `child.kill()` rather than an injected `AbortSignal`, because the delivery path is the
 * part that was broken in #146 and an injected signal proves nothing about it.
 *
 * The wait is on output, not on a clock, whenever the caller gives a pattern. A fixed delay
 * has to be long enough for the slowest runner to have started and short enough that the
 * fastest one has not finished, and no number satisfies both: on a fast machine 250 ms
 * arrived before the CLI had installed its handler, so the signal killed a program that was
 * still loading and the scenario reported cancellation as broken.
 */
async function interrupt(
  args: readonly string[],
  signal: 'SIGINT' | 'SIGTERM',
  afterMs: number,
  repeat: number,
  context: StepContext,
  afterOutput?: string,
): Promise<Executed> {
  return await new Promise<Executed>((resolve) => {
    const child = spawn(process.execPath, [context.binary, '--cwd', context.project, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timers: NodeJS.Timeout[] = [];

    const send = (): void => {
      if (signalled) return;
      signalled = true;
      for (let index = 0; index < repeat; index += 1) {
        timers.push(setTimeout(() => child.kill(signal), index * 750));
      }
    };

    const pattern = afterOutput === undefined ? null : new RegExp(afterOutput);
    const considerSignalling = (): void => {
      if (pattern === null || signalled) return;
      if (pattern.test(stdout) || pattern.test(stderr)) {
        // A settling delay after the stage announces itself, so the signal lands inside the
        // work rather than in the instant between two stages.
        timers.push(setTimeout(send, afterMs));
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      considerSignalling();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      considerSignalling();
    });

    if (pattern === null) timers.push(setTimeout(send, afterMs));
    // If the stage never announces itself the scenario must fail loudly rather than hang,
    // and it must fail saying the signal was never sent rather than blaming cancellation.
    else timers.push(setTimeout(send, 120_000));

    // A build that ignores the signal must fail the scenario rather than hang the suite.
    const guard = setTimeout(() => child.kill('SIGKILL'), afterMs + 300_000);

    child.on('close', (code, killedBy) => {
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(guard);
      resolve({
        code: code ?? (killedBy === 'SIGKILL' ? 137 : 1),
        stdout,
        stderr,
      });
    });
  });
}

/** Sorted keys, so a comparison reports a real difference rather than key churn. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Starts a command and resolves when it exits, so another can run alongside it. */
function start(args: readonly string[], context: StepContext): Promise<Executed> {
  return new Promise<Executed>((resolve) => {
    const child = spawn(process.execPath, [context.binary, '--cwd', context.project, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Scenario paths are project-relative, except captured ones, which are already absolute. */
function resolveInProject(project: string, path: string): string {
  return isAbsolute(path) ? path : join(project, ...path.split('/'));
}

/** The repository, from the binary at `<repo>/packages/cli/dist/entry.js`. */
function repoRootOf(binary: string): string {
  return dirname(dirname(dirname(dirname(binary))));
}

async function runExternal(
  command: string,
  args: readonly string[],
  context: StepContext,
): Promise<Executed | null> {
  try {
    const { stdout, stderr } = await execute(command, [...args], {
      cwd: context.project,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code === 'ENOENT') return null;
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function check(result: Executed, expect: Expect | undefined, context: StepContext): string[] {
  if (expect === undefined) return [];
  const problems: string[] = [];
  const tail = `\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;

  if (expect.exitCode !== undefined && result.code !== expect.exitCode) {
    problems.push(`exited ${result.code}, expected ${expect.exitCode}${tail}`);
  }
  if (expect.errorCode !== undefined) {
    const combined = `${result.stdout}${result.stderr}`;
    if (!combined.includes(expect.errorCode)) {
      problems.push(`no ${expect.errorCode} in the output${tail}`);
    }
  }
  problems.push(...text('stdout', result.stdout, expect.stdout, context));
  problems.push(...text('stderr', result.stderr, expect.stderr, context));

  if (expect.stdoutIsJson === true || expect.json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      problems.push(
        `stdout is not valid JSON on its own (${error instanceof Error ? error.message : String(error)})${tail}`,
      );
      return problems;
    }
    for (const assertion of expect.json ?? []) {
      problems.push(...json(parsed, assertion, context));
    }
  }
  return problems;
}

function text(
  stream: string,
  actual: string,
  expect: TextExpect | undefined,
  context: StepContext,
): string[] {
  if (expect === undefined) return [];
  const problems: string[] = [];
  if (expect.empty === true && actual.trim() !== '') {
    problems.push(`${stream} should be empty but was:\n${actual}`);
  }
  for (const needle of expect.contains ?? []) {
    const wanted = fill(needle, context.captures);
    if (!actual.includes(wanted))
      problems.push(`${stream} lacks ${JSON.stringify(wanted)}:\n${actual}`);
  }
  for (const needle of expect.excludes ?? []) {
    const unwanted = fill(needle, context.captures);
    if (actual.includes(unwanted)) {
      problems.push(`${stream} contains ${JSON.stringify(unwanted)} and should not:\n${actual}`);
    }
  }
  for (const pattern of expect.matches ?? []) {
    if (!new RegExp(fill(pattern, context.captures)).test(actual)) {
      problems.push(`${stream} does not match /${pattern}/:\n${actual}`);
    }
  }
  for (const { pattern, atLeast } of expect.occurrences ?? []) {
    const found = actual.match(new RegExp(fill(pattern, context.captures), 'g'))?.length ?? 0;
    if (found < atLeast) {
      problems.push(
        `${stream} shows /${pattern}/ ${found} time${found === 1 ? '' : 's'}, expected at least ${atLeast}:\n${actual}`,
      );
    }
  }
  return problems;
}

function json(parsed: unknown, assertion: JsonExpect, context: StepContext): string[] {
  const value = pluck(parsed, assertion.path);
  const problems: string[] = [];
  const show = (input: unknown): string => JSON.stringify(input);

  if (assertion.exists === true && value === undefined)
    problems.push(`${assertion.path} is absent`);
  if (assertion.exists === false && value !== undefined) {
    problems.push(`${assertion.path} is present (${show(value)}) and should not be`);
  }
  if (assertion.equals !== undefined && show(value) !== show(assertion.equals)) {
    problems.push(`${assertion.path} is ${show(value)}, expected ${show(assertion.equals)}`);
  }
  if (assertion.matches !== undefined && !new RegExp(assertion.matches).test(String(value))) {
    problems.push(`${assertion.path} is ${show(value)}, expected to match /${assertion.matches}/`);
  }
  if (
    assertion.atLeast !== undefined &&
    !(typeof value === 'number' && value >= assertion.atLeast)
  ) {
    problems.push(`${assertion.path} is ${show(value)}, expected at least ${assertion.atLeast}`);
  }
  if (assertion.equalsCapture !== undefined) {
    const expected = context.captures.get(assertion.equalsCapture);
    if (String(value) !== expected) {
      problems.push(`${assertion.path} is ${show(value)}, expected ${show(expected)}`);
    }
  }
  if (assertion.differsFromCapture !== undefined) {
    const expected = context.captures.get(assertion.differsFromCapture);
    if (String(value) === expected) {
      problems.push(`${assertion.path} is ${show(value)}, expected it to differ`);
    }
  }
  return problems;
}

function capture(
  result: Executed,
  wanted: Readonly<Record<string, string>>,
  context: StepContext,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return ['cannot capture: stdout is not JSON. Set `json: true` on the step.'];
  }
  const problems: string[] = [];
  for (const [name, path] of Object.entries(wanted)) {
    const value = pluck(parsed, path);
    if (value === undefined) {
      problems.push(`cannot capture ${name}: ${path} is absent`);
      continue;
    }
    context.captures.set(name, String(value));
  }
  return problems;
}

/** Reads `a.b[0].c` out of parsed JSON. Deliberately small; scenarios assert, not query. */
export function pluck(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (match === null) return undefined;
    const [, key = '', indexes = ''] = match;
    if (key !== '') {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    for (const index of indexes.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index[1])];
    }
  }
  return current;
}

/** Substitutes `{{name}}` from values captured by earlier steps. */
export function fill(input: string, captures: ReadonlyMap<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => captures.get(name) ?? whole);
}

function materialise(project: string, scenario: Scenario): void {
  for (const [path, contents] of Object.entries(scenario.fixture.files ?? {})) {
    const target = join(project, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  const generated = scenario.fixture.generated;
  if (generated === undefined) return;

  const documents = join(project, 'docs');
  mkdirSync(documents, { recursive: true });
  // One template written once and copied, so a large corpus costs disk rather than CPU.
  // Content only has to be plausible prose; the scenarios that use it are about scale.
  const body = [`# Generated document\n`];
  for (let section = 0; section < generated.sectionsPerDocument; section += 1) {
    body.push(
      `## Section ${section}\n\nDeployment, rollback and access control are described here in a paragraph long enough to chunk.\n`,
    );
  }
  const template = join(documents, 'doc-0.md');
  writeFileSync(template, body.join('\n'), 'utf8');
  for (let index = 1; index < generated.documents; index += 1) {
    copyFileSync(template, join(documents, `doc-${index}.md`));
  }
}

function sourceFiles(project: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.lore' || entry.name === '.git') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.startsWith('lore.')) found.push(full);
    }
  };
  walk(project);
  return found;
}

function closeQuietly(handle: number): void {
  try {
    closeSync(handle);
  } catch {
    // Nothing useful to do with a failed close in a temp directory.
  }
}
