import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FIXTURES_ROOT = 'fixtures';

/** Set UPDATE_FIXTURES=1 to rewrite golden files. Reviewing that diff is the point. */
export function updateMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UPDATE_FIXTURES === '1';
}

/** Stable key ordering, so a golden diff shows real changes rather than key churn. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface GoldenResult {
  readonly matched: boolean;
  readonly written: boolean;
  readonly path: string;
  readonly expected?: string;
  readonly actual: string;
  readonly message?: string;
}

/**
 * Compares a value against a committed golden file. Returns a result rather than
 * asserting, so the caller supplies the assertion and the failure message stays scoped
 * to the differing path.
 */
export function compareGolden(goldenPath: string, value: unknown): GoldenResult {
  const actual = canonicalJson(value);
  if (updateMode()) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual, 'utf8');
    return { matched: true, written: true, path: goldenPath, actual };
  }
  if (!existsSync(goldenPath)) {
    return {
      matched: false,
      written: false,
      path: goldenPath,
      actual,
      message: `Golden file missing: ${goldenPath}\nRun with UPDATE_FIXTURES=1 to create it, then review the diff.`,
    };
  }
  const expected = readFileSync(goldenPath, 'utf8');
  if (expected === actual)
    return { matched: true, written: false, path: goldenPath, expected, actual };
  return {
    matched: false,
    written: false,
    path: goldenPath,
    expected,
    actual,
    message: `Golden mismatch: ${goldenPath}\n${describeFirstDifference(expected, actual)}\nRun with UPDATE_FIXTURES=1 to accept, then review the diff.`,
  };
}

export function describeFirstDifference(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      return `  line ${i + 1}\n    expected: ${e[i] ?? '<missing>'}\n    actual:   ${a[i] ?? '<missing>'}`;
    }
  }
  return '  files differ only in trailing content';
}

export function goldenPathFor(name: string, root = FIXTURES_ROOT): string {
  return join(root, 'expected', `${name}.json`);
}
