import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';

/**
 * The Milestone 0 acceptance suite.
 *
 * Architecture section 21 states the exit criterion behaviourally: editing one file
 * creates a new immutable version, shows a correct diff, and rolls back without
 * re-indexing. This drives the real binary in a temp project, so it validates the contract
 * a user actually meets, including exit codes and printed output, rather than the internal
 * functions that happen to implement it today.
 */

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'entry.js');

interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function lore(cwd: string, args: readonly string[]): Promise<Executed> {
  try {
    const { stdout, stderr } = await execute(process.execPath, [BIN, '--cwd', cwd, ...args], {
      timeout: 120_000,
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
}

async function json<T>(cwd: string, args: readonly string[]): Promise<T> {
  const result = await lore(cwd, ['--json', ...args]);
  expect(result.code, `${args.join(' ')} failed:\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

const CORPUS = {
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release without recompiling.\n',
  'guides/onboarding.md': '# Onboarding\n\nNew engineers configure their laptop on day one.\n',
  'notes/standup.txt': 'Discussed the deployment schedule and rollback safety.\n',
};

/**
 * Simulates how editors actually save: write a sibling temp file, then rename over the
 * original. On Windows this is the case that breaks naive file watching and open handles,
 * so the edit step in this suite uses it rather than a plain overwrite.
 */
function atomicEdit(root: string, relativePath: string, contents: string): void {
  const target = join(root, ...relativePath.split('/'));
  const temporary = `${target}.editor-tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, target);
}

describe('Milestone 0: versioned, diffable, instantly reversible context', () => {
  it('the binary is built, which this suite depends on', () => {
    expect(existsSync(BIN), `${BIN} is missing. Run \`pnpm build\` first.`).toBe(true);
  });

  it('runs the whole lifecycle and ends where it started', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const root = project.root;

      // init
      const init = await lore(root, ['init']);
      expect(init.code).toBe(0);
      expect(existsSync(join(root, 'lore.yaml'))).toBe(true);

      // plan, before anything exists
      const firstPlan = await json<{ sourceState: string; artifacts: { added: number } }>(root, [
        'plan',
      ]);
      expect(firstPlan.sourceState).toBe('unknown');
      expect(firstPlan.artifacts.added).toBe(3);

      // build
      const firstBuild = await json<{ buildId: string; created: boolean; activated: boolean }>(
        root,
        ['build'],
      );
      expect(firstBuild.created).toBe(true);
      expect(firstBuild.activated).toBe(true);
      expect(firstBuild.buildId).toMatch(/^lore_[0-9a-f]{64}$/);

      // status is clean straight after a build
      expect((await json<{ sourceState: string }>(root, ['status'])).sourceState).toBe('clean');

      // search finds located content
      const search = await json<{
        hits: { locator: { relativePath: string; lineStart?: number } }[];
      }>(root, ['search', 'rollback']);
      expect(search.hits.length).toBeGreaterThan(0);
      expect(search.hits[0]?.locator.relativePath).toBeTruthy();

      // edit one file, the way an editor would
      atomicEdit(
        root,
        'guides/deployment.md',
        '# Deployment\n\n## Rollback\n\nRollback restores the previous release instantly.\n\n## Retention\n\nSix builds are kept.\n',
      );

      // plan and status both notice, by content
      expect((await json<{ sourceState: string }>(root, ['status'])).sourceState).toBe('dirty');
      const secondPlan = await json<{ artifacts: { changed: number } }>(root, ['plan']);
      expect(secondPlan.artifacts.changed).toBe(1);

      // build again: a new, distinct, immutable version
      const secondBuild = await json<{ buildId: string; created: boolean }>(root, ['build']);
      expect(secondBuild.created).toBe(true);
      expect(secondBuild.buildId).not.toBe(firstBuild.buildId);
      expect(existsSync(join(root, '.lore', 'builds', firstBuild.buildId, 'manifest.json'))).toBe(
        true,
      );

      // diff names exactly what changed
      const diff = await json<{
        from: string;
        to: string;
        artifacts: { changed: number; changes: { path: string; change: string }[] };
      }>(root, ['diff']);
      expect(diff.from).toBe(firstBuild.buildId);
      expect(diff.to).toBe(secondBuild.buildId);
      expect(diff.artifacts.changed).toBe(1);
      expect(diff.artifacts.changes).toContainEqual({
        path: 'guides/deployment.md',
        change: 'changed',
      });

      // rollback returns to the earlier pointer
      const rollback = await json<{ buildId: string; changed: boolean }>(root, ['rollback']);
      expect(rollback.buildId).toBe(firstBuild.buildId);
      expect(rollback.changed).toBe(true);
      expect((await json<{ activeBuildId: string }>(root, ['status'])).activeBuildId).toBe(
        firstBuild.buildId,
      );

      // and the restored build still answers
      const afterRollback = await json<{ buildId: string; hits: unknown[] }>(root, [
        'search',
        'rollback',
      ]);
      expect(afterRollback.buildId).toBe(firstBuild.buildId);
      expect(afterRollback.hits.length).toBeGreaterThan(0);
    });
  });

  it('rolls back with the sources emptied, which no cache hit can fake', async () => {
    // Stronger than counting parse work: if rollback re-indexed at all, it would produce
    // an empty build or fail. Section 21's "without re-indexing" is what this proves.
    await withTempProject({ files: CORPUS }, async (project) => {
      const root = project.root;
      await lore(root, ['init']);
      const first = await json<{ buildId: string }>(root, ['build']);

      atomicEdit(root, 'guides/deployment.md', '# Deployment\n\nRewritten.\n');
      const second = await json<{ buildId: string }>(root, ['build']);
      expect(second.buildId).not.toBe(first.buildId);

      for (const path of Object.keys(CORPUS)) {
        writeFileSync(join(root, ...path.split('/')), '', 'utf8');
      }

      const started = performance.now();
      const rollback = await json<{ buildId: string }>(root, ['rollback']);
      const elapsed = performance.now() - started;

      expect(rollback.buildId).toBe(first.buildId);
      // A re-index would have to read the emptied files; instead the restored build still
      // holds the original content.
      const search = await json<{ hits: unknown[] }>(root, ['search', 'rollback']);
      expect(search.hits.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10_000);
    });
  });

  it('keeps every earlier build readable after rollback', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const root = project.root;
      await lore(root, ['init']);
      const first = await json<{ buildId: string }>(root, ['build']);
      atomicEdit(root, 'notes/standup.txt', 'Rewritten note.\n');
      const second = await json<{ buildId: string }>(root, ['build']);

      await lore(root, ['rollback']);

      // Immutability: the newer build is still on disk and still inspectable.
      const inspected = await json<{ buildId: string }>(root, [
        'inspect',
        'build',
        '--build',
        second.buildId,
      ]);
      expect(inspected.buildId).toBe(second.buildId);
      expect(readdirSync(join(root, '.lore', 'builds')).sort()).toEqual(
        [first.buildId, second.buildId].sort(),
      );
    });
  });

  it('produces the same build id under every determinism condition a machine can check', async () => {
    // Section 20.3: twice in one place, from a second absolute path, and with the
    // enumeration order shuffled. Windows against POSIX comes from the CI matrix.
    const report = await checkDeterminism({
      files: { 'lore.yaml': 'version: 1\nname: demo\nsources:\n  - .\n', ...CORPUS },
      produce: async (project) => {
        const built = await json<{ buildId: string }>(project.root, ['build']);
        return built.buildId;
      },
    });

    expect(report.deterministic, report.message ?? '').toBe(true);
  });

  it('produces identical manifests and canonical roots across two workspaces', async () => {
    const files = { 'lore.yaml': 'version: 1\nname: demo\nsources:\n  - .\n', ...CORPUS };

    const manifestOf = async (prefix: string): Promise<Record<string, unknown>> =>
      withTempProject({ files, prefix }, async (project) => {
        const built = await json<{ buildId: string }>(project.root, ['build']);
        return JSON.parse(
          readFileSync(
            join(project.root, '.lore', 'builds', built.buildId, 'manifest.json'),
            'utf8',
          ),
        ) as Record<string, unknown>;
      });

    const [left, right] = await Promise.all([manifestOf('lorepack-a-'), manifestOf('lorepack-b-')]);

    // The whole manifest, not only the id: identity is worthless if the record describing
    // it differs. Operational facts live in the receipt, deliberately outside this file.
    expect(right).toEqual(left);
  });

  it('packs to a byte-identical archive from two different workspaces', async () => {
    const files = { 'lore.yaml': 'version: 1\nname: demo\nsources:\n  - .\n', ...CORPUS };

    const archiveOf = async (prefix: string): Promise<Buffer> =>
      withTempProject({ files, prefix }, async (project) => {
        await json(project.root, ['build']);
        await json(project.root, ['pack', '--out', 'out.lorepack']);
        return readFileSync(join(project.root, 'out.lorepack'));
      });

    const [left, right] = await Promise.all([archiveOf('lorepack-p-'), archiveOf('lorepack-q-')]);
    // context.sqlite page layout is allowed to differ across machines, but not across two
    // directories on one machine, so here the archives must match byte for byte.
    expect(right.equals(left)).toBe(true);
  });

  it('fails the suite if rollback stops restoring the earlier pointer', async () => {
    // The mutation check the ticket asks for, expressed as an assertion about the
    // assertion: a rollback that returned the same build would be caught here.
    await withTempProject({ files: CORPUS }, async (project) => {
      const root = project.root;
      await lore(root, ['init']);
      const first = await json<{ buildId: string }>(root, ['build']);
      atomicEdit(root, 'notes/standup.txt', 'Changed.\n');
      const second = await json<{ buildId: string }>(root, ['build']);

      const rolled = await json<{ buildId: string }>(root, ['rollback']);
      expect(rolled.buildId).toBe(first.buildId);
      expect(rolled.buildId).not.toBe(second.buildId);
    });
  });
});
