import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

// Exercise the actual binary with Swedish and English locale requests. Assert the
// explicit canonical order as well as equal bytes, including on hosts that retain
// their system locale despite the requested environment.
async function lore(root: string, args: readonly string[], lang: string): Promise<string> {
  const { stdout } = await execute(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, LANG: lang, LC_ALL: lang },
    timeout: 60_000,
  });
  return stdout;
}

describe('lorepack diff across locales', () => {
  it('prints byte-identical JSON in code-unit order under two locales', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: demo\nsources:\n  - .\n',
          'rates.csv': 'ä,z,a\n1,1,1\n',
        },
      },
      async (temp) => {
        await lore(temp.root, ['build'], 'en_US.UTF-8');
        writeFileSync(join(temp.root, 'rates.csv'), 'ä,z,a\n2,2,2\n', 'utf8');
        await lore(temp.root, ['build'], 'en_US.UTF-8');

        const swedish = await lore(temp.root, ['diff', '--json'], 'sv_SE.UTF-8');
        const english = await lore(temp.root, ['diff', '--json'], 'en_US.UTF-8');
        expect(swedish).toBe(english);

        const diff = JSON.parse(english) as {
          tables: { cellChanges: { column: string }[] }[];
        };
        expect(diff.tables[0]?.cellChanges.map((change) => change.column)).toEqual(['a', 'z', 'ä']);
      },
    );
  }, 120_000);
});
