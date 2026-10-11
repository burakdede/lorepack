import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A third-party corpus cannot drive the terminal through Lorepack's human output (#579).
 *
 * File names and document text reach the screen through `init`, `inspect`, `search`, `diff`,
 * `plan` and `status`. Printed raw, an escape sequence in either sets the terminal title, plants
 * an OSC 8 link whose visible text differs from its target, clears the screen, or, where the
 * terminal allows it, writes the clipboard. The binary is driven as a person drives it, with its
 * output piped, which is how `| less` and `| cat` reach a terminal too.
 *
 * Windows refuses control characters in file names, so there the hostile text is in document
 * content only; everywhere else it is in a file name as well.
 */

const ENTRY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const ESC = '\u001b';
const BEL = '\u0007';
const CSI = '\u009b';

/** Sets the title, colours red, and resets: three sequences in one name. */
const HOSTILE_NAME =
  process.platform === 'win32'
    ? 'evil-red.md'
    : `evil${ESC}]0;PWNED${BEL}${ESC}[31mred${ESC}[0m.md`;
/** A spoofed OSC 8 link, a screen clear, a C1 CSI, and a bare carriage return. */
const HOSTILE_TEXT = `# Title\n\nSee ${ESC}]8;;http://evil.example${ESC}\\click${ESC}]8;;${ESC}\\ here ${ESC}[2J ${CSI}31m and\rmore about rollback.\n`;

let project: string;

function lorepack(args: readonly string[]): { code: number; output: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: project,
    encoding: 'utf8',
    input: '',
    timeout: 110_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** Every raw control a terminal acts on: C0 except tab and newline, DEL, and C1. */
function firstRawControl(output: string): number | undefined {
  for (const character of output) {
    const code = character.charCodeAt(0);
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return code;
  }
  return undefined;
}

function expectInert(output: string): void {
  const found = firstRawControl(output);
  expect(found, `raw control U+${found?.toString(16).padStart(4, '0')} in:\n${output}`).toBe(
    undefined,
  );
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-terminal-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', HOSTILE_NAME), HOSTILE_TEXT);
  writeFileSync(join(project, 'docs', 'plain.md'), '# Plain\n\nRollback restores the build.\n');
  if (process.platform !== 'win32') {
    // A credential-shaped name, which `init` names in its warning.
    writeFileSync(join(project, 'docs', `id_rsa${ESC}[31m.pem`), 'not a key\n');
  }
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('human output with a hostile corpus (#579)', () => {
  it('stays inert through init, build, inspect, search, plan, status and diff', () => {
    const runs: { args: readonly string[]; output: string }[] = [];
    const run = (args: readonly string[]): string => {
      const { code, output } = lorepack(args);
      expect(code, `${args.join(' ')}\n${output}`).toBeLessThan(3);
      runs.push({ args, output });
      return output;
    };

    run(['init']);
    run(['build']);
    const sources = run(['inspect', 'sources']);
    run(['inspect', 'chunks']);
    run(['inspect', `docs/${HOSTILE_NAME}`]);
    const found = run(['search', 'rollback']);

    // A second hostile document, unbuilt, so `plan` and `status` have a change to name.
    writeFileSync(join(project, 'docs', `two-${HOSTILE_NAME}`), HOSTILE_TEXT);
    run(['plan']);
    run(['status']);
    run(['build']);
    run(['diff']);

    for (const { output } of runs) expectInert(output);

    // Still legible: the sequences are shown as text a person can read and report.
    expect(found).toContain('\\x1b]8;;http://evil.example');
    if (process.platform !== 'win32') expect(sources).toContain('evil\\x1b]0;PWNED\\x07');
  });

  it('keeps an error naming a hostile path inert too', () => {
    const { code, output } = lorepack(['inspect', `docs/missing${ESC}[2J.md`]);

    expect(code).not.toBe(0);
    expectInert(output);
    expect(output).toContain('\\x1b[2J');
  });
});
