import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** One test as Vitest's JSON reporter saw it, keyed by its repository-relative file. */
export interface Outcome {
  readonly file: string;
  readonly fullName: string;
  readonly status: string;
}

/**
 * A security class, the tests that hold it, and where they run.
 *
 * `tests` are matched against the reporter's full name (describe titles joined to the test
 * title), either exactly or as its trailing part, so a shared contract run once per client
 * names its tests once.
 */
export interface Evidence {
  readonly name: string;
  /** Where the tests are written, and where `patterns` must appear. */
  readonly path: string;
  /** The files Vitest runs, when `path` is a shared contract rather than a test file. */
  readonly runFrom?: readonly string[];
  readonly tests: readonly string[];
  /**
   * What the test source must still assert. Kept beside the run check because a test whose
   * body is emptied still reports `passed`.
   */
  readonly patterns: readonly RegExp[];
  /**
   * The written allow-list for platform skips: on these platforms, and only these, the
   * named tests may report skipped, for the reason given. They must still be reported.
   */
  readonly skippedOn?: Partial<Record<NodeJS.Platform, string>>;
}

export const runFiles = (item: Evidence): readonly string[] => item.runFrom ?? [item.path];

const normalize = (path: string): string => path.replaceAll('\\', '/');

/**
 * Runs test files in a fresh Vitest process and returns what its JSON reporter recorded.
 *
 * A child process rather than Vitest's node API inside this worker, so the run gets the
 * same project configuration `pnpm test` uses and none of this suite's own state. `root`
 * selects a Vitest root other than the repository's, for suites outside the default run.
 */
export function runVitest(files: readonly string[], root?: string): readonly Outcome[] {
  const out = mkdtempSync(join(tmpdir(), 'lore-security-report-'));
  const report = join(out, 'report.json');
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS',
      ),
    );
    const args = [VITEST, 'run', '--reporter=json', `--outputFile=${report}`];
    if (root !== undefined) args.push('--root', root);
    const result = spawnSync(process.execPath, [...args, ...files], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    let text: string;
    try {
      text = readFileSync(report, 'utf8');
    } catch {
      throw new Error(
        `vitest wrote no report (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
      );
    }
    const parsed = JSON.parse(text) as {
      readonly testResults: readonly {
        readonly name: string;
        readonly assertionResults: readonly {
          readonly fullName: string;
          readonly status: string;
        }[];
      }[];
    };
    return parsed.testResults.flatMap((file) =>
      file.assertionResults.map((test) => ({
        file: normalize(relative(ROOT, file.name)),
        fullName: test.fullName,
        status: test.status,
      })),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const SKIPPED = new Set(['skipped', 'pending']);

const names = (fullName: string, wanted: string): boolean =>
  fullName === wanted || fullName.endsWith(` ${wanted}`);

/**
 * Every way the outcomes fail to prove the evidence: a named test that is missing, failed,
 * or skipped where no written platform reason allows it. Empty means the class is held.
 */
export function problems(
  item: Evidence,
  outcomes: readonly Outcome[],
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const found: string[] = [];
  for (const file of runFiles(item)) {
    const inFile = outcomes.filter((outcome) => outcome.file === file);
    for (const wanted of item.tests) {
      const matches = inFile.filter((outcome) => names(outcome.fullName, wanted));
      if (matches.length === 0) {
        found.push(`${file}: "${wanted}" was not reported`);
        continue;
      }
      for (const match of matches) {
        if (match.status === 'passed') continue;
        if (SKIPPED.has(match.status) && item.skippedOn?.[platform] !== undefined) continue;
        found.push(`${file}: "${match.fullName}" reported ${match.status}, not passed`);
      }
    }
  }
  return found;
}
