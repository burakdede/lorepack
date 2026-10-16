import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
const BIOME = join(REPO, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

/**
 * The ban on `localeCompare` in compiler and core (#592) is a Biome plugin scoped by an
 * override, so it is easy to lose by editing `biome.json`. This lints a copy of the real
 * configuration against one probe inside the scope and one outside it.
 */
describe('localeCompare lint ban', () => {
  it.each(['a.localeCompare(b)', "a.localeCompare(b, 'en')", "a.localeCompare(b, 'sv', {})"])(
    'rejects %s in compiler and core sources only',
    (expression) => {
      const root = mkdtempSync(join(tmpdir(), 'lore-locale-lint-'));
      try {
        mkdirSync(join(root, 'tools', 'lint'), { recursive: true });
        copyFileSync(join(REPO, 'biome.json'), join(root, 'biome.json'));
        copyFileSync(
          join(REPO, 'tools', 'lint', 'no_locale_compare.grit'),
          join(root, 'tools', 'lint', 'no_locale_compare.grit'),
        );
        for (const pkg of ['core', 'compiler', 'cli']) {
          mkdirSync(join(root, 'packages', pkg, 'src'), { recursive: true });
          writeFileSync(
            join(root, 'packages', pkg, 'src', 'probe.ts'),
            `export const order = (a: string, b: string): number => ${expression};\n`,
            'utf8',
          );
        }

        let output = '';
        try {
          output = execFileSync(
            process.execPath,
            [BIOME, 'lint', '--vcs-enabled=false', '--reporter=json', '.'],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );
        } catch (error) {
          output = (error as { stdout?: string }).stdout ?? '';
        }
        const report = JSON.parse(output) as {
          diagnostics: { category: string; location: { path: string } }[];
        };
        const flagged = report.diagnostics
          .filter((diagnostic) => diagnostic.category === 'plugin')
          .map((diagnostic) => diagnostic.location.path.split('\\').join('/'))
          .sort();
        expect(flagged).toEqual(['packages/compiler/src/probe.ts', 'packages/core/src/probe.ts']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
