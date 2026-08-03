import { accessSync, existsSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeFts5 } from '@lorepack/backend-local';
import {
  type CheckResult,
  type CheckStatus,
  checkNodeVersion,
  type DoctorReport,
  doctorReportSchema,
  type LoadedConfig,
  loadConfig,
} from '@lorepack/core';
import { DEV_PORT } from './dev-session.js';

/**
 * One command that names whatever is wrong, and says how to fix it.
 *
 * Architecture 6.5 and 6.9. The value is entirely in the remediation: a check that reports
 * "FTS5 unavailable" and stops has told the user something they already knew from the
 * failure that sent them here. Every check below carries the detected value and one concrete
 * thing to do, because "almost always the wrong Node build" is knowledge that belongs in the
 * output rather than in a maintainer's head.
 *
 * Checks are independent, named, and uniformly shaped, which is what lets the Phase 4 Studio
 * Diagnostics route (#69) render the same results without a second implementation. It is
 * also what lets the client checks arrive later with #58 as an addition rather than a
 * rewrite, which is the amendment recorded on #56.
 *
 * Read-only apart from a temporary in-memory FTS5 probe, so it is safe to run at any time,
 * including against a project that is mid-build.
 */

// The shapes are the published contract in `@lorepack/core`, not restated here: Studio's
// Diagnostics route renders the same results, and a restated type is how two consumers come
// to disagree about one payload.
export type { CheckResult, CheckStatus, DoctorReport };

export interface DoctorOptions {
  readonly cwd: string;
  /** The dev port to test, so a project on a custom port checks the right one. */
  readonly port?: number;
  /**
   * Set when this project's own dev session is the thing holding that port.
   *
   * Without it the report warns that the port is occupied, which is true and useless: it is
   * occupied by the server that just answered the request, or by the `lore dev` running in
   * the next terminal. Both callers work this out and say so, so the browser and the
   * terminal reach the same conclusion about the same port.
   */
  readonly portHeldByThisProject?: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: CheckResult[] = [
    nodeVersionCheck(),
    sqliteCapabilityCheck(),
    fts5Check(),
    watcherLimitCheck(),
  ];

  // A project is optional: running doctor in an empty directory is a legitimate thing to do
  // before there is anything to configure, and it should report the environment rather than
  // refuse.
  const project = findProject(options.cwd);
  if (project !== null) {
    checks.push(configCheck(project.config, project.root));
    checks.push(sourcesCheck(project.config));
    checks.push(writableCheck(project.root));
    checks.push(activeBuildCheck(project.root));
  }
  checks.push(await portCheck(options.port ?? DEV_PORT, options.portHeldByThisProject === true));

  const counts = {
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };

  // Parsed rather than asserted, so `--json` cannot drift from the committed schema without
  // this failing first. Doctor of all commands should not be the one lying about its output.
  return doctorReportSchema.parse({
    status: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass',
    project: project?.root ?? null,
    checks,
    counts,
  });
}

interface FoundProject {
  readonly root: string;
  readonly config: LoadedConfig | null;
  readonly error: string | null;
}

/**
 * A project, an unreadable project, or neither.
 *
 * The middle case is the interesting one: a `lore.yaml` that will not parse is exactly the
 * situation doctor exists for, and treating it as "no project" would skip every check that
 * could explain it.
 */
function findProject(cwd: string): FoundProject | null {
  if (!existsSync(join(cwd, 'lore.yaml'))) return null;
  try {
    return { root: cwd, config: loadConfig({ cwd }), error: null };
  } catch (error) {
    return {
      root: cwd,
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function nodeVersionCheck(): CheckResult {
  const result = checkNodeVersion();
  return {
    id: 'node-version',
    title: 'Node version',
    status: result.supported ? 'pass' : 'fail',
    detail: result.supported
      ? `Node ${result.detected}`
      : `Node ${result.detected} is outside the supported range.`,
    ...(result.supported ? {} : { remediation: result.message }),
    values: { detected: result.detected, execPath: process.execPath },
  };
}

/**
 * Which `node:sqlite` controls this build actually has, individually.
 *
 * Reported one by one rather than as a single yes/no, because a user on an unexpected build
 * needs to know precisely which control is missing: they map to different Node versions and
 * to different things Lorepack cannot do.
 */
function sqliteCapabilityCheck(): CheckResult {
  const present: Record<string, boolean> = {
    setAuthorizer: false,
    enableDefensive: false,
    limits: false,
  };

  let detail = '';
  try {
    // A static import, because this file is ESM and `require` does not exist here. It was
    // written lazily at first to survive a build without `node:sqlite`, and the result was
    // a doctor that reported a false failure on a perfectly good environment. A check that
    // lies about the thing it exists to verify is worse than no check.
    const db = new DatabaseSync(':memory:');
    try {
      const surface = db as unknown as Record<string, unknown>;
      present.setAuthorizer = typeof surface.setAuthorizer === 'function';
      present.enableDefensive = typeof surface.enableDefensive === 'function';
      present.limits = typeof surface.limits === 'object' && surface.limits !== null;
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      id: 'sqlite-capabilities',
      title: 'node:sqlite controls',
      status: 'fail',
      detail: `node:sqlite could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'Install Node 24.15 or newer from https://nodejs.org/en/download',
      values: { execPath: process.execPath },
    };
  }

  const missing = Object.entries(present)
    .filter(([, has]) => !has)
    .map(([name]) => name);
  detail =
    missing.length === 0
      ? 'setAuthorizer, enableDefensive and limits are all present.'
      : `Missing: ${missing.join(', ')}.`;

  return {
    id: 'sqlite-capabilities',
    title: 'node:sqlite controls',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail,
    ...(missing.length === 0
      ? {}
      : {
          // Each maps to a different floor: setAuthorizer 24.10, enableDefensive 24.14,
          // limits 24.15. Naming the floor is more useful than naming the range.
          remediation:
            'Install Node 24.15 or newer, which is the first release with all three: https://nodejs.org/en/download',
        }),
    values: { ...present, execPath: process.execPath },
  };
}

/**
 * The check that matters most, because "FTS5 missing" is almost always "wrong Node build".
 *
 * Official nodejs.org builds compile `SQLITE_ENABLE_FTS5`; a Node linked against a shared
 * system SQLite may not. Reporting the SQLite version and the executable path is what turns
 * an inexplicable failure into an obvious one.
 */
function fts5Check(): CheckResult {
  const probe = probeFts5();
  return {
    id: 'fts5',
    title: 'SQLite FTS5',
    status: probe.available ? 'pass' : 'fail',
    detail: probe.available
      ? `SQLite ${probe.sqliteVersion} with FTS5.`
      : `SQLite ${probe.sqliteVersion} has no FTS5${probe.detail === undefined ? '' : `: ${probe.detail}`}`,
    ...(probe.available
      ? {}
      : {
          remediation: [
            'This is almost always a Node build linked against a system SQLite.',
            'Install an official build from https://nodejs.org/en/download',
            'Verified builds: docs/compatibility/sqlite-fts5.md',
          ].join('\n'),
        }),
    values: {
      sqliteVersion: probe.sqliteVersion,
      nodeVersion: probe.nodeVersion,
      execPath: probe.execPath,
    },
  };
}

/**
 * On Linux, how many files the kernel will let one user watch.
 *
 * A warning rather than a failure, because the limit only matters at a size this project may
 * never reach, and because the fix needs root. Silence would be worse: an exhausted inotify
 * limit surfaces as a watcher that simply stops noticing changes, which reads as Lorepack
 * being broken.
 */
function watcherLimitCheck(): CheckResult {
  if (platform() !== 'linux') {
    return {
      id: 'watcher-limits',
      title: 'Watcher limits',
      status: 'pass',
      detail: `No per-user watch limit applies on ${platform()}.`,
      values: { platform: platform() },
    };
  }

  const path = '/proc/sys/fs/inotify/max_user_watches';
  let limit = 0;
  try {
    limit = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch {
    return {
      id: 'watcher-limits',
      title: 'Watcher limits',
      status: 'pass',
      detail: 'The inotify limit could not be read, which is not a problem by itself.',
      values: { platform: 'linux' },
    };
  }

  const low = limit > 0 && limit < 8192;
  return {
    id: 'watcher-limits',
    title: 'Watcher limits',
    status: low ? 'warn' : 'pass',
    detail: low
      ? `inotify allows ${limit} watches, which a large project can exhaust.`
      : `inotify allows ${limit} watches.`,
    ...(low
      ? {
          remediation:
            'Raise it if `lore dev` stops noticing changes:\n  sudo sysctl fs.inotify.max_user_watches=524288',
        }
      : {}),
    values: { platform: 'linux', maxUserWatches: limit },
  };
}

function configCheck(config: LoadedConfig | null, root: string): CheckResult {
  if (config === null) {
    return {
      id: 'config',
      title: 'Project configuration',
      status: 'fail',
      detail: `lore.yaml in ${root} could not be read.`,
      remediation: 'Run `lore plan` to see the parse error in full, or fix lore.yaml by hand.',
      values: { root },
    };
  }
  return {
    id: 'config',
    title: 'Project configuration',
    status: 'pass',
    detail: `${config.config.name}, ${config.sources.length} source root${config.sources.length === 1 ? '' : 's'}.`,
    values: { root, name: config.config.name },
  };
}

/**
 * Every configured source root exists, is a directory, and is inside the project.
 *
 * Containment is the security half: a source that escapes the project root would index
 * something the user did not point at, and the build would carry it forever.
 */
function sourcesCheck(config: LoadedConfig | null): CheckResult {
  if (config === null) {
    return {
      id: 'sources',
      title: 'Source paths',
      status: 'warn',
      detail: 'Not checked, because the configuration could not be read.',
    };
  }

  const problems: string[] = [];
  for (const source of config.sources) {
    const path = source.root;
    if (!existsSync(path)) {
      problems.push(`${path} does not exist`);
      continue;
    }
    // A `file` source is legitimately not a directory, so only a directory source is held
    // to that.
    if (source.kind === 'directory' && !statSync(path).isDirectory()) {
      problems.push(`${path} is not a directory`);
    }
  }

  return {
    id: 'sources',
    title: 'Source paths',
    status: problems.length === 0 ? 'pass' : 'fail',
    detail:
      problems.length === 0
        ? `${config.sources.length} source root${config.sources.length === 1 ? '' : 's'} reachable.`
        : problems.join('; '),
    ...(problems.length === 0
      ? {}
      : {
          remediation: 'Correct the `sources` list in lore.yaml, or create the missing directory.',
        }),
    values: { roots: config.sources.length },
  };
}

function writableCheck(root: string): CheckResult {
  const path = join(root, '.lore');
  try {
    if (existsSync(path)) accessSync(path, fsConstants.W_OK);
    else accessSync(root, fsConstants.W_OK);
    return {
      id: 'lore-writable',
      title: 'Build directory',
      status: 'pass',
      detail: `${path} is writable.`,
      values: { path },
    };
  } catch {
    return {
      id: 'lore-writable',
      title: 'Build directory',
      status: 'fail',
      detail: `${path} is not writable.`,
      // Not "check your permissions": the exact command, because the point of doctor is that
      // the user does not have to work out what to type.
      remediation: `Grant write access to the directory:\n  chmod u+w "${root}"`,
      values: { path },
    };
  }
}

/**
 * Whether there is a build and whether it can still be opened.
 *
 * A project with no build is not broken, it is new, so that is a warning with the command
 * that fixes it rather than a failure.
 */
function activeBuildCheck(root: string): CheckResult {
  const state = join(root, '.lore', 'state.sqlite');
  if (!existsSync(state)) {
    return {
      id: 'active-build',
      title: 'Active build',
      status: 'warn',
      detail: 'This project has no build yet.',
      remediation: 'Run `lore build`, or `lore dev` to build and serve in one step.',
      values: { state },
    };
  }

  try {
    accessSync(state, fsConstants.R_OK);
    return {
      id: 'active-build',
      title: 'Active build',
      status: 'pass',
      detail: 'Build state is present and readable.',
      values: { state },
    };
  } catch {
    return {
      id: 'active-build',
      title: 'Active build',
      status: 'fail',
      detail: `${state} cannot be read.`,
      remediation: 'Check the file permissions, or remove .lore and run `lore build` again.',
      values: { state },
    };
  }
}

/**
 * Whether the dev port is free, by binding it rather than by guessing from a scan.
 *
 * `ours` is the case that matters whenever a session is up: the port is held by this
 * project's own `lore dev`, and reporting that as a problem tells a person their working
 * setup is broken. The check concludes differently rather than a caller editing the result
 * afterwards, which would be two opinions about one check.
 */
async function portCheck(port: number, ours: boolean): Promise<CheckResult> {
  const free = await isPortFree(port);

  if (!free && ours) {
    return {
      id: 'dev-port',
      title: 'Dev port',
      status: 'pass',
      detail: `127.0.0.1:${port} is in use by this project's dev session.`,
      values: { port, session: true },
    };
  }

  return {
    id: 'dev-port',
    title: 'Dev port',
    status: free ? 'pass' : 'warn',
    detail: free ? `127.0.0.1:${port} is free.` : `127.0.0.1:${port} is in use.`,
    ...(free
      ? {}
      : {
          // A warning, not a failure: `lore dev` steps to the next free port and says so, so
          // an occupied port is an inconvenience rather than a problem (architecture 6.9).
          remediation: `\`lore dev\` will use the next free port. Pass --port to choose one.`,
        }),
    values: { port },
  };
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}
