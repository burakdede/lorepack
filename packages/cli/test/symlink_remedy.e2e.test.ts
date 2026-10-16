import { execFile } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function lore(root: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execute(process.execPath, [BIN, ...args], {
    cwd: root,
    timeout: 60_000,
  });
  return `${stdout}${stderr}`;
}

/**
 * The `symlink-skipped` warning used to say "Set followSymlinks to include them", and
 * `lore.yaml` rejects that key (#592). This follows the advice the warning gives now, through
 * the real binary, and proves the linked content becomes searchable.
 */
describe('symlink-skipped remedy', () => {
  it('names a fix that a strict lore.yaml accepts and that indexes the target', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: demo\nsources:\n  - docs\n',
          'docs/a.md': '# A\n\nAlpha.\n',
          'notes/n.md': '# Notes\n\nThe quokka lives here.\n',
        },
      },
      async (temp) => {
        // A junction on Windows, which needs no privilege; a plain directory link elsewhere.
        symlinkSync(temp.path('notes'), temp.path('docs/notes'), 'junction');

        const plan = await lore(temp.root, ['plan']);
        expect(plan).toContain('was skipped');
        expect(plan).toContain('copy the target into a source directory');
        expect(plan).toContain("add the target's directory to `sources` in lore.yaml");
        expect(plan).not.toContain('followSymlinks');

        writeFileSync(
          join(temp.root, 'lore.yaml'),
          'version: 1\nname: demo\nsources:\n  - docs\n  - notes\n',
          'utf8',
        );
        await lore(temp.root, ['build']);
        expect(await lore(temp.root, ['search', 'quokka'])).toContain('n.md');
      },
    );
  }, 120_000);
});
