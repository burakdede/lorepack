import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderOwnedTable } from '@lorepack/connect-clients';
import { loadConfig } from '@lorepack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lorepack disconnect` through the built binary, against client files seeded by hand (#581).
 *
 * Disconnecting needs no client installed, so these run the same on every machine. The home
 * directory, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are all temporary: no real client
 * configuration is read or written.
 */

const ENTRY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const CONFIG = 'version: 1\nname: disconnected\nsources:\n  - .\n';

let scratch: string;
let home: string;
let projectA: string;
let projectB: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lore-disconnect-e2e-'));
  home = join(scratch, 'home');
  projectA = join(scratch, 'project-a');
  projectB = join(scratch, 'project-b');
  for (const directory of [home, projectA, projectB]) {
    mkdirSync(directory);
    if (directory !== home) writeFileSync(join(directory, 'lore.yaml'), CONFIG);
  }
  mkdirSync(join(home, '.codex'));
  // The root the CLI records ownership under. Run from inside the project, its working
  // directory is the real path (`/private/var` rather than `/var` on macOS).
  projectA = loadConfig({ cwd: realpathSync.native(projectA) }).projectRoot;
  projectB = loadConfig({ cwd: realpathSync.native(projectB) }).projectRoot;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function lorepack(cwd: string, args: readonly string[]): { code: number; stdout: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      XDG_CONFIG_HOME: join(home, '.config'),
      CLAUDE_CONFIG_DIR: home,
      CODEX_HOME: join(home, '.codex'),
      NO_COLOR: '1',
    },
  });
  return { code: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

const codexBlock = (projectRoot: string): string =>
  renderOwnedTable({
    path: ['mcp_servers', 'lorepack'],
    projectRoot,
    values: { command: 'lorepack', args: ['mcp', '--project', projectRoot], cwd: projectRoot },
    createdAt: '2026-10-01T00:00:00.000Z',
  });

describe('a user-scope entry another project created (#581)', () => {
  it('is left in place, and the project it belongs to is named', () => {
    const codex = join(home, '.codex', 'config.toml');
    const claude = join(home, '.claude.json');
    const codexText = `# mine\nmodel = "x"\n\n${codexBlock(projectA)}\n`;
    const claudeText = `${JSON.stringify(
      {
        mcpServers: {
          lorepack: {
            command: 'lorepack',
            'x-lorepack': { projectRoot: projectA, createdAt: '2026-10-01T00:00:00.000Z' },
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(codex, codexText);
    writeFileSync(claude, claudeText);

    const result = lorepack(projectB, ['disconnect', '--scope', 'user']);

    expect(result.code, result.stdout).toBe(0);
    expect(readFileSync(codex, 'utf8')).toBe(codexText);
    expect(readFileSync(claude, 'utf8')).toBe(claudeText);
    expect(result.stdout).toContain(`which belongs to ${projectA}`);
  });
});

describe('a project file holding a multi-line string (#581)', () => {
  it('comes back byte for byte, blank lines inside the string included', () => {
    const before = 'developer_instructions = """\nOne.\n\n\nTwo.\n"""\n';
    const path = join(projectA, '.codex', 'config.toml');
    mkdirSync(join(projectA, '.codex'));
    writeFileSync(path, `${before}\n${codexBlock(projectA)}\n`);

    const result = lorepack(projectA, ['disconnect', 'codex']);

    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain('removed the Lorepack entry');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
