import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
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
        await runBuild({ config, progress: new ProgressBus() });
        writeReceipt(config, {
          pid: process.pid,
          port: 4747,
          startedAt: new Date().toISOString(),
        } as Parameters<typeof writeReceipt>[1]);

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
});
