import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'dist', 'public-entry.js');
const HERE = import.meta.dirname;

export const EGRESS_FIXTURES = join(HERE, '..', 'fixtures', 'egress');

export interface SandboxRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** What the in-process monitor saw, in order. Empty when the monitor was off. */
  readonly attempts: readonly string[];
  /** Packets the network namespace transmitted during the run, or null outside one. */
  readonly packets: number | null;
}

export interface SandboxOptions {
  /** Load the in-process monitor. Off only to show the kernel counters stand alone. */
  readonly monitor?: boolean;
  /** Modules loaded into the build process before it starts, standing in for build code. */
  readonly inject?: readonly string[];
  /** Modules loaded into every process of the build, the parse child included. */
  readonly injectEverywhere?: readonly string[];
}

/** True inside the namespace the Linux CI job sets up; see `netns.sh`. */
export const IN_NETWORK_NAMESPACE = process.env.LORE_PRIVACY_NETNS === '1';

/**
 * Every packet any interface in this network namespace has transmitted.
 *
 * Inside the namespace there is a loopback and a dummy interface holding the default route,
 * so a packet to anywhere, including a DNS query to any resolver, is counted on one of them
 * and then goes nowhere.
 */
export function transmittedPackets(): number {
  const base = '/sys/class/net';
  return readdirSync(base).reduce(
    (sum, name) =>
      sum + Number(readFileSync(join(base, name, 'statistics', 'tx_packets'), 'utf8').trim()),
    0,
  );
}

const imports = (path: string): string[] => ['--import', pathToFileURL(path).href];

/** The same preloads as `--import`, in the form `NODE_OPTIONS` carries into a child. */
const nodeOptionImports = (paths: readonly string[]): string =>
  paths.map((path) => `"--import=${pathToFileURL(path).href}"`).join(' ');

/**
 * Runs `lorepack build` in its own Node process under the permission model.
 *
 * The grants are the whole sandbox: read anywhere, write only inside the project, start a
 * child process, and nothing else. With no `--allow-worker`, `--allow-addons` or
 * `--allow-wasi`, Node refuses each of those outright.
 *
 * `--allow-child-process` is there because the build parses every file in a forked
 * `parse-child.js` (#594). The monitor refuses every other process, and lets that fork through
 * only when it runs under the permission model with no write, process or worker grant. The
 * preloads travel in `NODE_OPTIONS` rather than as flags so the parse child loads the monitor
 * too, which keeps the parsers, the code that reads hostile documents, inside the proof.
 */
export function runSandboxedBuild(projectRoot: string, options: SandboxOptions = {}): SandboxRun {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run pnpm build first`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS',
    ),
  );
  const args = [
    '--permission',
    '--allow-fs-read=*',
    // The real path: macOS's temp directory is reached through a link, and Node checks the
    // grant against the resolved path a write lands on.
    `--allow-fs-write=${realpathSync(projectRoot)}`,
    '--allow-child-process',
    ...(options.inject ?? []).flatMap(imports),
    CLI,
    'build',
  ];
  const preloads = [
    join(HERE, 'fsync.mjs'),
    ...(options.monitor === false ? [] : [join(HERE, 'monitor.mjs')]),
    ...(options.injectEverywhere ?? []),
  ];
  const before = IN_NETWORK_NAMESPACE ? transmittedPackets() : null;
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: { ...env, NO_COLOR: '1', NODE_OPTIONS: nodeOptionImports(preloads) },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const packets = before === null ? null : transmittedPackets() - before;
  const attempts = result.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('LORE_EGRESS_ATTEMPT '))
    .map((line) => line.slice('LORE_EGRESS_ATTEMPT '.length));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, attempts, packets };
}

/** Every reason a run fails the privacy default. Empty means it built and reached nothing. */
export function egressProblems(run: SandboxRun): readonly string[] {
  const problems: string[] = [];
  if (run.code !== 0) problems.push(`the build exited ${run.code}: ${run.stderr.trim()}`);
  for (const attempt of run.attempts) problems.push(`network attempt: ${attempt}`);
  if (run.packets !== null && run.packets > 0) {
    problems.push(`${run.packets} packets left the build's network namespace`);
  }
  return problems;
}
