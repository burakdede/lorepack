import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCKFILE_NAME,
  type Lockfile,
  LoreError,
  lockfileSchema,
  writeFileAtomic,
} from '@lorepack/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * `lore.lock` records every version that can change build output.
 *
 * The point is not to prevent change; it is to make change **visible**. A parser upgrade
 * legitimately alters extracted structure and therefore the build id, and a user who has
 * pinned reproducibility in CI needs that to be a loud failure rather than a silent
 * difference between two machines.
 */

export interface LockfileInputs {
  readonly compilerVersion: string;
  readonly schemaVersion: number;
  readonly parserVersions: Readonly<Record<string, string>>;
}

export function buildLockfile(inputs: LockfileInputs): Lockfile {
  return {
    formatVersion: 1,
    compiler: inputs.compilerVersion,
    schema: inputs.schemaVersion,
    // Sorted, so a lockfile diff shows a version change rather than key reordering.
    parsers: Object.fromEntries(
      Object.entries(inputs.parserVersions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    semantic: null,
  };
}

export function renderLockfile(lock: Lockfile): string {
  return stringifyYaml(lock, { lineWidth: 0 });
}

export function readLockfile(projectRoot: string): Lockfile | null {
  const path = join(projectRoot, LOCKFILE_NAME);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new LoreError('LORE_E_CONFIG_INVALID', `${LOCKFILE_NAME} is not valid YAML.`, {
      remediation: `Delete ${LOCKFILE_NAME} and run \`lore build\` to regenerate it.`,
      path: LOCKFILE_NAME,
      cause,
    });
  }

  const result = lockfileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new LoreError(
      'LORE_E_CONFIG_INVALID',
      `${LOCKFILE_NAME} is invalid at \`${(issue?.path ?? []).join('.')}\`: ${issue?.message ?? 'unknown problem'}`,
      {
        remediation: `Delete ${LOCKFILE_NAME} and run \`lore build\` to regenerate it.`,
        path: LOCKFILE_NAME,
      },
    );
  }
  return result.data;
}

export function writeLockfile(projectRoot: string, lock: Lockfile): void {
  writeFileAtomic(join(projectRoot, LOCKFILE_NAME), renderLockfile(lock));
}

export interface LockChange {
  readonly key: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface LockDrift {
  readonly changed: boolean;
  readonly changes: readonly LockChange[];
}

/** Compares a committed lockfile against what this run would write. */
export function compareLockfiles(previous: Lockfile | null, next: Lockfile): LockDrift {
  if (previous === null) {
    return { changed: true, changes: [{ key: LOCKFILE_NAME, from: null, to: 'created' }] };
  }

  const changes: LockChange[] = [];
  if (previous.compiler !== next.compiler) {
    changes.push({ key: 'compiler', from: previous.compiler, to: next.compiler });
  }
  if (previous.schema !== next.schema) {
    changes.push({ key: 'schema', from: String(previous.schema), to: String(next.schema) });
  }

  const names = [
    ...new Set([...Object.keys(previous.parsers), ...Object.keys(next.parsers)]),
  ].sort();
  for (const name of names) {
    const from = previous.parsers[name] ?? null;
    const to = next.parsers[name] ?? null;
    if (from !== to) changes.push({ key: `parsers.${name}`, from, to });
  }

  const previousSemantic = previous.semantic === null ? null : JSON.stringify(previous.semantic);
  const nextSemantic = next.semantic === null ? null : JSON.stringify(next.semantic);
  if (previousSemantic !== nextSemantic) {
    changes.push({ key: 'semantic', from: previousSemantic, to: nextSemantic });
  }

  return { changed: changes.length > 0, changes };
}

/**
 * `--frozen` fails on drift with the exact diff.
 *
 * A generic mismatch error would send someone to diff two files by hand; the whole value
 * of the flag is knowing immediately which version moved.
 */
export function assertNoDrift(drift: LockDrift): void {
  if (!drift.changed) return;
  const lines = drift.changes.map(
    (change) => `  ${change.key}: ${change.from ?? 'absent'} -> ${change.to ?? 'absent'}`,
  );
  throw new LoreError(
    'LORE_E_LOCKFILE_DRIFT',
    `${LOCKFILE_NAME} would change, but --frozen was requested:\n${lines.join('\n')}`,
    {
      remediation: `Run \`lore build\` without --frozen and commit the updated ${LOCKFILE_NAME}, or pin the versions it expects.`,
      path: LOCKFILE_NAME,
      details: { changes: drift.changes },
    },
  );
}
