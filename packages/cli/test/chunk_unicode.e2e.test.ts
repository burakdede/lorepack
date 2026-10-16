import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function lore(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute(process.execPath, [BIN, ...args], { cwd, timeout: 60_000 });
  return stdout;
}

// Native context delivery already preserves full bodies. Keep that behavior while
// changing stored chunk boundaries and parse-cache identity.
describe('chunks served for astral text', () => {
  it('exports split emoji text intact, with no replacement characters', async () => {
    // An odd-length prefix puts every pair across an even offset, so a hard cut at the
    // budget lands inside one unless the chunker steps off it.
    const body = `zebrafish x${'\u{1F600}'.repeat(6000)}`;
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: emoji\nsources:\n  - .\n',
          'emoji.md': `# Emoji\n\n${body}\n`,
        },
      },
      async (temp) => {
        await lore(temp.root, ['build']);
        const exported = await lore(temp.root, [
          'export',
          '--task',
          'zebrafish',
          '--format',
          'json',
        ]);

        expect(exported).toContain('zebrafish');
        expect(exported).toContain('\u{1F600}');
        expect(exported).not.toContain('�');
        // JSON escapes a lone surrogate rather than dropping it, so look for that too.
        expect(exported).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
        expect(exported.isWellFormed()).toBe(true);
      },
    );
  });
});
