import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/fs/atomic.js';

/**
 * Owner-only writes for `.lore` (#569), and ordinary ones for project files such as
 * `lore.yaml` and `lore.lock`, which are meant to be committed and shared.
 *
 * POSIX only: Windows has no mode bits for Node to set beyond read-only, so there is nothing
 * to assert there.
 */
const posixOnly = process.platform === 'win32';

let previousUmask: number;
beforeEach(() => {
  if (!posixOnly) previousUmask = process.umask(0o022);
});
afterEach(() => {
  if (!posixOnly) process.umask(previousUmask);
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(posixOnly)('writeFileAtomic modes', () => {
  it('creates an owner-only file 0600 and its missing directories 0700', async () => {
    await withTempProject({}, (project) => {
      const path = project.path('.lore/cache/parse/ab/entry.json');
      writeFileAtomic(path, 'private', { ownerOnly: true });
      expect(readFileSync(path, 'utf8')).toBe('private');
      expect(mode(path)).toBe(0o600);
      for (const directory of [
        '.lore',
        '.lore/cache',
        '.lore/cache/parse',
        '.lore/cache/parse/ab',
      ]) {
        expect(mode(project.path(directory)), directory).toBe(0o700);
      }
    });
  });

  it('leaves an ordinary project file to the umask', async () => {
    await withTempProject({}, (project) => {
      const path = join(project.root, 'lore.lock');
      writeFileAtomic(path, 'shared');
      expect(mode(path)).toBe(0o644);
    });
  });
});
