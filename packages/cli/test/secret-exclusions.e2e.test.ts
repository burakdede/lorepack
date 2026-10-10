import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientConnector,
  createClaudeCodeConnector,
  createCodexConnector,
  createVsCodeConnector,
} from '@lorepack/connect-clients';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { run } from './helpers.js';

/**
 * Issues 573 and 585, end to end: `init`, `connect`, `build`, then ask the build for every
 * planted secret.
 *
 * `init` makes the whole project a source, and `connect` then writes MCP client
 * configuration, and backups of it, into that same project. Those files hold tokens in a
 * server's `env` block. Separately, `init` names credential-shaped files and promises they are
 * never indexed. Both are claims about what reaches a model, so both are asserted against
 * what search actually returns rather than against a list of patterns.
 */

const TOKENS = {
  codex: 'ghpLEAKMEcodex123',
  mcp: 'hunter2pwmcp',
  vscode: 'vscodeTOKENleak77',
  claude: 'claudeLOCALleak55',
  cursor: 'cursorTOKENleak99',
  envrc: 'direnvSECRET4242',
  jks: 'keystorePASSjks11',
  gcp: 'gcpPRIVATEkey3141',
};

const FILES = {
  'docs/runbook.md': '# Runbook\n\nRestart the worker with a pointer change.\n',
  '.codex/config.toml': `[mcp_servers.github]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "${TOKENS.codex}" }\n`,
  '.mcp.json': `{"mcpServers":{"pg":{"command":"pg-mcp","env":{"PGPASSWORD":"${TOKENS.mcp}"}}}}\n`,
  '.vscode/mcp.json': `{"servers":{"api":{"command":"api-mcp","env":{"API_TOKEN":"${TOKENS.vscode}"}}}}\n`,
  '.claude/settings.local.json': `{"env":{"TOKEN":"${TOKENS.claude}"}}\n`,
  '.cursor/mcp.json': `{"mcpServers":{"x":{"env":{"TOKEN":"${TOKENS.cursor}"}}}}\n`,
  '.envrc': `export SECRET=${TOKENS.envrc}\n`,
  'certs/release.jks': `${TOKENS.jks}\n`,
  'gcp-credentials.json': `{"private_key":"-----BEGIN PRIVATE KEY-----${TOKENS.gcp}"}\n`,
};

const answers = async () => ({ ok: true, step: 'none' as const, detail: 'Answered.' });

function connectors(codexHome: string, vscodeUser: string): ClientConnector[] {
  return [
    createCodexConnector({
      runClient: async () => ({ stdout: 'codex-cli 0.146.1\n', stderr: '' }),
      home: codexHome,
      probe: answers,
    }),
    createClaudeCodeConnector({
      runClient: async () => ({ stdout: '1.2.3 (Claude Code)\n', stderr: '' }),
      shared: true,
    }),
    createVsCodeConnector({
      runClient: async () => ({ stdout: '1.132.0\nabc\nx64\n', stderr: '' }),
      userConfigDirectory: vscodeUser,
      probe: answers,
    }),
  ];
}

describe('what init and connect put in a project stays out of the build', () => {
  it('indexes none of the client configuration, its backups, or credential-shaped files', async () => {
    await withTempProject({ files: FILES }, async (temp) => {
      const root = temp.root;
      const initialized = await run(['--cwd', root, 'init']);
      expect(initialized.code).toBe(0);
      // The promise init makes is checked against the files it names.
      expect(initialized.stdout).toContain('look like credentials');
      for (const named of ['.envrc', 'certs/release.jks', 'gcp-credentials.json']) {
        expect(initialized.stdout).toContain(named);
      }

      // The connectors `lorepack connect` runs, with only client detection and the live probe
      // faked, so the files and backups written are exactly the ones a user would get. Codex
      // and VS Code user scope point at a scratch home, never the developer's own.
      const home = mkdtempSync(join(tmpdir(), 'lorepack-home-'));
      try {
        for (const connector of connectors(join(home, 'codex'), join(home, 'vscode'))) {
          await connector.apply(
            await connector.plan({
              projectRoot: root,
              serverName: 'lorepack',
              command: { executable: 'lorepack', args: ['mcp', '--project', root] },
              scope: 'project',
            }),
          );
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
      const backups = [
        ...readdirSync(root),
        ...readdirSync(join(root, '.codex')),
        ...readdirSync(join(root, '.vscode')),
      ].filter((name) => name.includes('.lorepack-') && name.endsWith('.bak'));
      expect(backups.length).toBeGreaterThanOrEqual(3);

      const build = await run(['--cwd', root, 'build']);
      expect(build.code).toBe(0);

      const sources = await run(['--cwd', root, 'inspect', 'sources']);
      expect(sources.stdout).toContain('docs/runbook.md');
      for (const leaked of ['.mcp.json', '.codex', '.vscode', '.claude', '.cursor', '.bak']) {
        expect(sources.stdout).not.toContain(leaked);
      }
      for (const leaked of ['.envrc', 'release.jks', 'gcp-credentials.json']) {
        expect(sources.stdout).not.toContain(leaked);
      }

      for (const token of Object.values(TOKENS)) {
        const search = await run(['--cwd', root, 'search', token]);
        expect(search.code, token).toBe(0);
        expect(search.stdout, token).toContain('No matches');
      }
      // The guard is not simply an empty build.
      const control = await run(['--cwd', root, 'search', 'pointer']);
      expect(control.stdout).toContain('docs/runbook.md');
    });
  }, 120_000);

  /**
   * The init warning matched names case-insensitively while discovery matches them as
   * written, so `Prod-Credentials.json` was named as "never indexed" and then built. Whatever
   * the matching rule is, the two must share it: every file init names is absent from the
   * build that follows.
   */
  it('names only files the build then leaves out', async () => {
    await withTempProject(
      {
        files: {
          'docs/a.md': '# A\n',
          'Prod-Credentials.json': '{"key":"mixedCASEsecret"}\n',
          'keys/prod-credentials.json': '{"key":"lowerCASEsecret"}\n',
        },
      },
      async (temp) => {
        const initialized = await run(['--cwd', temp.root, 'init']);
        const named = initialized.stdout
          .split('\n')
          .filter((line) => line.startsWith('  ') && !line.startsWith('  +'))
          .map((line) => line.trim());
        expect(named).toContain('keys/prod-credentials.json');

        expect((await run(['--cwd', temp.root, 'build'])).code).toBe(0);
        const sources = (await run(['--cwd', temp.root, 'inspect', 'sources'])).stdout;
        for (const file of named) expect(sources, file).not.toContain(file);
      },
    );
  }, 120_000);
});
