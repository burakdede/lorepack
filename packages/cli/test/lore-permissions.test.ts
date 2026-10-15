import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LocalActiveBuildProvider,
  LocalStateStore,
  openWritable,
  ProjectLock,
  stateMigrationsDirectory,
} from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { writeReceipt } from '../src/services/dev-session.js';

/**
 * `.lore` holds a normalized copy of every source, in objects and in the parse cache (#569).
 * Written with default modes, a 0600 source became a world-readable 0644 copy, so on a shared
 * machine another user could read what the owner had protected. Everything under `.lore` is
 * now created owner-only: 0700 directories, 0600 files.
 *
 * POSIX only. Windows has no mode bits for Node to set beyond read-only; `.lore` there is
 * protected by the user profile's default ACLs, which `docs/architecture/local-storage.md`
 * records. A test that asserted modes on Windows would assert nothing.
 */
const posixOnly = process.platform === 'win32';

const SECRET = 'Confidential salary plan';

let previousUmask: number;

beforeEach(() => {
  // The permissive umask the issue was reproduced under, so the result does not depend on
  // the umask of whoever runs the suite.
  if (!posixOnly) previousUmask = process.umask(0o022);
});

afterEach(() => {
  if (!posixOnly) process.umask(previousUmask);
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}

describe.skipIf(posixOnly)('what a build writes under .lore', () => {
  it('is owner-only: 0700 directories and 0600 files, including the copy of a 0600 source', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: private\nsources:\n  - docs\n',
          'docs/secret.md': `# Plan\n\n${SECRET}.\n`,
          'docs/data.csv': 'name,amount\nA,1\n',
        },
      },
      async (project) => {
        chmodSync(project.path('docs/secret.md'), 0o600);
        const config = loadConfig({ cwd: project.root });
        const built = await runBuild({ config, progress: new ProgressBus() });
        writeReceipt(config, {
          pid: process.pid,
          port: 4747,
          startedAt: new Date().toISOString(),
          host: '127.0.0.1',
          buildId: built.buildId,
        });

        const lore = project.path('.lore');
        const entries = [lore, ...walk(lore)];
        const wrong = entries
          .map((path) => {
            const stats = statSync(path);
            const expected = stats.isDirectory() ? 0o700 : 0o600;
            const mode = stats.mode & 0o777;
            return mode === expected ? null : `${path.slice(lore.length)} ${mode.toString(8)}`;
          })
          .filter((line) => line !== null);
        expect(wrong).toEqual([]);

        // The copies that motivated the issue exist, so the assertion above covered them.
        const holdingSecret = entries.filter(
          (path) => statSync(path).isFile() && readFileSync(path).includes(SECRET),
        );
        expect(holdingSecret.length).toBeGreaterThan(0);
      },
    );
  });

  it('includes the project lock while it is held', async () => {
    await withTempProject({}, async (project) => {
      const lock = new ProjectLock(project.path('.lore/lock'));
      await lock.acquire();
      try {
        expect(statSync(project.path('.lore')).mode & 0o777).toBe(0o700);
        expect(statSync(project.path('.lore/lock')).mode & 0o777).toBe(0o700);
        expect(statSync(project.path('.lore/lock/owner.json')).mode & 0o777).toBe(0o600);
      } finally {
        lock.release();
      }
    });
  });
  it('keeps live reader references and SQLite journals private', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: private\nsources: [docs]\n',
          'docs/a.md': '# Private\n\nReader snapshot.\n',
        },
      },
      async (project) => {
        await runBuild({ config: loadConfig({ cwd: project.root }), progress: new ProgressBus() });
        const lore = project.path('.lore');
        const state = LocalStateStore.open(lore, stateMigrationsDirectory());
        const provider = new LocalActiveBuildProvider(state, join(lore, 'builds'));
        const writer = openWritable(join(lore, 'state.sqlite'));
        try {
          const handle = await provider.acquire();
          try {
            writer.exec('BEGIN IMMEDIATE; CREATE TABLE permissions_probe (n INTEGER)');
            expect(statSync(join(lore, 'state.sqlite-journal')).mode & 0o777).toBe(0o600);
            const references = walk(join(lore, 'readers'));
            expect(references.length).toBeGreaterThan(0);
            expect(references.every((path) => (statSync(path).mode & 0o777) === 0o600)).toBe(true);
            const wrong = [lore, ...walk(lore)]
              .filter((path) => {
                const stats = statSync(path);
                return (stats.mode & 0o777) !== (stats.isDirectory() ? 0o700 : 0o600);
              })
              .map((path) => path.slice(lore.length));
            expect(wrong).toEqual([]);
          } finally {
            if (writer.isTransaction) writer.exec('ROLLBACK');
            await handle.release();
          }
        } finally {
          provider.closeAll();
          writer.close();
          state.close();
        }
      },
    );
  });
  it('creates private build data through the installed CLI entry point', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: private\nsources: [docs]\n',
          'docs/a.md': '# Private\n\nActual CLI build.\n',
        },
      },
      (project) => {
        const output = execFileSync(
          process.execPath,
          [
            join(import.meta.dirname, '..', 'dist', 'public-entry.js'),
            '--cwd',
            project.root,
            '--json',
            'build',
          ],
          { encoding: 'utf8', timeout: 30_000 },
        );
        expect(JSON.parse(output).buildId).toMatch(/^lore_[0-9a-f]{64}$/);
        const lore = project.path('.lore');
        const wrong = [lore, ...walk(lore)]
          .filter((path) => {
            const stats = statSync(path);
            return (stats.mode & 0o777) !== (stats.isDirectory() ? 0o700 : 0o600);
          })
          .map((path) => path.slice(lore.length));
        expect(wrong).toEqual([]);
      },
    );
  });
});
