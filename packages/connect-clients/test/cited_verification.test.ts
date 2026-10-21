import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createLocalRuntimeBackend, FileObjectStore } from '../../backend-local/src/index.js';
import { createRuntime } from '../../runtime/src/index.js';
import { createClaudeCodeConnector } from '../src/claude-code.js';
import { createCodexConnector } from '../src/codex.js';
import { renderVerifiedSnippet } from '../src/snippet.js';
import { verifyStdioServer } from '../src/verify.js';
import { createVsCodeConnector } from '../src/vscode.js';
import { readExpectedSource as expected } from './expected_build.js';

const BINARY = join(import.meta.dirname, '../../cli/dist/entry.js');
const roots: string[] = [];

function project(text: string, build = true): string {
  const root = mkdtempSync(join(tmpdir(), 'lorepack-connect-cited-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'lore.yaml'), 'version: 1\nname: cited\nsources: [docs]\n');
  writeFileSync(join(root, 'docs/a.md'), text);
  if (build) {
    const result = spawnSync(process.execPath, [BINARY, '--cwd', root, 'build'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('rejects an actual different project even though its server lists all Lorepack tools', async () => {
  const intended = project('# Intended project\n');
  const other = project('# Another project\n');
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', other, 'mcp'],
    expected: () => expected(intended),
  });
  expect(check.ok, check.detail).toBe(false);
  expect(check.step).toBe('build');
  expect(check.detail).toContain((await expected(intended)).buildId);
}, 120_000);

it('rejects a server when the independently expected project has no active build', async () => {
  const intended = project('# Not built\n', false);
  const other = project('# A working different project\n');
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', other, 'mcp'],
    expected: () => expected(intended),
  });
  expect(check.ok, check.detail).toBe(false);
  expect(check.step).toBe('build');
  expect(check.detail).toMatch(/build/i);
}, 120_000);

it('returns the expected immutable build and citation after an actual source read', async () => {
  const root = project('# Known source\n\nA verified cited read.\n');
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', root, 'mcp'],
    expected: () => expected(root),
  });
  const reference = await expected(root);
  expect(check.ok, check.detail).toBe(true);
  expect(check.proof).toEqual({ buildId: reference.buildId, locator: reference.source.locator });
}, 120_000);

it.each([
  ['claude-code', createClaudeCodeConnector],
  ['codex', createCodexConnector],
  ['vscode', createVsCodeConnector],
] as const)(
  'rejects the wrong project through the actual %s configuration adapter',
  async (_id, create) => {
    const intended = project('# Expected by this configuration\n');
    const other = project('# Wrong project in the configured command\n');
    const directory = join(intended, 'client-home');
    mkdirSync(directory);
    const home = realpathSync(directory);
    const connector = create({
      home,
      configDirectory: home,
      userConfigDirectory: home,
      runClient: async () => ({ stdout: 'lorepack: connected\n', stderr: '' }),
    });
    const plan = await connector.plan({
      projectRoot: intended,
      serverName: 'lorepack',
      scope: 'user',
      command: { executable: process.execPath, args: [BINARY, '--cwd', other, 'mcp'] },
    });
    expect(plan.configPath?.startsWith(home + sep)).toBe(true);
    const receipt = await connector.apply(plan);
    const check = await connector.verify(receipt, () => expected(intended));
    expect(check.ok, check.detail).toBe(false);
    expect(check.step).toBe('build');
  },
  120_000,
);

it('rejects a wrong-project verified snippet without changing the configuration', async () => {
  const intended = project('# Expected snippet project\n');
  const other = project('# Actual other snippet project\n');
  const snippet = await renderVerifiedSnippet(
    {
      projectRoot: intended,
      serverName: 'lorepack',
      scope: 'project',
      command: { executable: process.execPath, args: [BINARY, '--cwd', other, 'mcp'] },
    },
    () => expected(intended),
  );
  expect(snippet.verification?.ok, snippet.verification?.detail).toBe(false);
  expect(snippet.verification?.step, snippet.verification?.detail).toBe('build');
}, 120_000);

it('obtains the independent expectation after ensure-current creates the intended build', async () => {
  const root = project('# Built during verification\n', false);
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', root, 'mcp', '--ensure-current'],
    expected: () => expected(root),
  });
  expect(check.ok, check.detail).toBe(true);
  expect(check.proof?.buildId).toBe((await expected(root)).buildId);
}, 120_000);

it('refuses to report an empty source as a working cited connection', async () => {
  const root = project('');
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', root, 'mcp'],
    expected: () => expected(root),
  });
  expect(check.ok, check.detail).toBe(false);
  expect(check.step).toBe('source');
  expect(check.detail).toMatch(/readable|empty/i);
}, 120_000);

it('fails an actual source read when the body disappears after the independent expectation', async () => {
  const root = project('# Available while selecting the expected source\n');
  const check = await verifyStdioServer({
    executable: process.execPath,
    args: [BINARY, '--cwd', root, 'mcp'],
    expected: async () => {
      const reference = await expected(root);
      const backend = createLocalRuntimeBackend({ projectRoot: root });
      try {
        const page = await createRuntime(backend).listSources({
          buildId: reference.buildId,
          limit: 1,
        });
        const artifact = page.artifacts[0];
        expect(artifact).toBeDefined();
        if (artifact === undefined)
          throw new Error('The fixture did not contain its known source.');
        new FileObjectStore(join(root, '.lore', 'objects')).quarantine(artifact.objectHash);
      } finally {
        backend.close();
      }
      return reference;
    },
  });
  expect(check.ok, check.detail).toBe(false);
  expect(check.step).toBe('source');
  expect(check.detail).toContain('lore_read_source');
  expect(check.detail).toContain('reconnect');
}, 120_000);
