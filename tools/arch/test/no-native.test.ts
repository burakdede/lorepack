import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The guard that keeps invariant 7 checkable (#256).
 *
 * `check:no-native` was narrowed from "no native code anywhere in `node_modules`" to "no native
 * code a **user** would install". That is a real narrowing, and the only thing that makes it
 * safe is this file: the whole-tree version could not tell a build tool in a contributor's
 * checkout from a native dependency shipped to users, and refused both.
 *
 * So the assertion is the mutation, not the happy path. A test that only ran the check and
 * expected zero would pass just as happily against a check that had stopped looking.
 */

const root = join(import.meta.dirname, '..', '..', '..');
const manifest = join(root, 'packages', 'sdk', 'package.json');
const original = readFileSync(manifest, 'utf8');

function check(): { code: number; output: string } {
  try {
    const output = execFileSync('node', ['scripts/check-no-native.mjs'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

afterEach(() => {
  writeFileSync(manifest, original);
});

describe('the no-native guard', () => {
  it('passes on the repository as it stands', () => {
    expect(check().code).toBe(0);
  });

  /**
   * The one that matters. A published package taking a native dependency is the thing
   * invariant 7 forbids, and it must fail whatever else the check learns to ignore.
   *
   * Declared rather than installed: the check reads the production closure from the manifests,
   * so this needs no `pnpm install` and cannot leave a native package behind if it fails.
   */
  it('fails when a published package declares a native dependency', () => {
    const declared = JSON.parse(original) as { dependencies?: Record<string, string> };
    declared.dependencies = { ...declared.dependencies, sharp: '0.34.4' };
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);

    const result = check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('sharp');
  });

  it('still refuses an install hook in one of our own packages', () => {
    const declared = JSON.parse(original) as { scripts?: Record<string, string> };
    declared.scripts = { ...declared.scripts, postinstall: 'echo hello' };
    writeFileSync(manifest, `${JSON.stringify(declared, null, 2)}\n`);

    const result = check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('postinstall');
  });
});
