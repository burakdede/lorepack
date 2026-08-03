import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lore mcp` as a coding agent actually launches it: a subprocess, spoken to by the real
 * MCP client over stdio.
 *
 * Everything that matters here is invisible in-process. Whether stdout stays byte-pure
 * protocol while diagnostics go to stderr, whether the startup sequence reconciles
 * freshness before the first frame, and whether a client can connect at all: none of that
 * is exercised by calling a function.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'entry.js');

const CONFIG = 'version: 1\nname: served\nsources:\n  - .\n';
/**
 * Deliberately worded the way a real runbook is, so a task phrased as a question shares
 * vocabulary with it. The tokenizer does not stem, so "roll back a release" finds this
 * because the document says "roll back" and "release", not because anything is clever.
 */
const DOCUMENT = [
  '# Deployment',
  '',
  '## Rollback',
  '',
  'To roll back a release, activate the previous build. Rollback never recompiles.',
  '',
  '## Release',
  '',
  'A release goes out on Tuesday unless a change freeze is in effect.',
  '',
].join('\n');

let project: string;
let client: Client | null = null;

/**
 * `mode` is the era this client negotiates, and it has to be said out loud.
 *
 * The SDK default is `'legacy'`, so a client written the obvious way drives the server
 * through the removed `initialize` handshake. Every test below that does not name an era is
 * therefore asserting the backward-compatibility path, which is worth having and is not
 * what "2026-07-28 conformance" means (#189).
 */
async function connect(
  args: readonly string[],
  mode: 'legacy' | 'auto' = 'legacy',
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BINARY, '--cwd', project, 'mcp', ...args],
    // stderr is where every diagnostic goes, and the client must not care what is on it.
    stderr: 'pipe',
  });
  const connected = new Client(
    { name: 'stdio-contract-tests', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  await connected.connect(transport);
  client = connected;
  return connected;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-mcp-'));
  writeFileSync(join(project, 'lore.yaml'), CONFIG, 'utf8');
  writeFileSync(join(project, 'deployment.md'), DOCUMENT, 'utf8');
});

afterEach(async () => {
  await client?.close();
  client = null;
  try {
    // Windows holds the build database open a moment after the child exits, and a leaked
    // temporary directory must never fail a run that already passed its assertions.
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Nothing to do: the operating system will clean its own temp directory.
  }
});

describe('a client launching the server', () => {
  it('builds the project first, then serves it, all before the first protocol frame', async () => {
    // No build exists yet, so --ensure-current has to create one. A client should never
    // have to know that happened.
    const connected = await connect(['--ensure-current']);

    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('lore_search');

    const info = await connected.callTool({ name: 'lore_build_info', arguments: {} });
    const described = info.structuredContent as { buildId: string; sourceState: string };
    expect(described.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
    expect(described.sourceState).toBe('clean');
  }, 120_000);

  it('answers a task with cited passages from the real corpus', async () => {
    const connected = await connect(['--ensure-current']);
    const result = await connected.callTool({
      name: 'lore_context_for_task',
      arguments: { task: 'how do I roll back a release' },
    });

    const bundle = result.structuredContent as {
      citations: Array<{ relativePath: string }>;
      estimatedTokens: number;
      budget: number;
    };
    expect(bundle.citations.length).toBeGreaterThan(0);
    expect(bundle.citations[0]?.relativePath).toBe('deployment.md');
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(bundle.budget);
  }, 120_000);

  it('reads an exact range out of the build', async () => {
    const connected = await connect(['--ensure-current']);
    const result = await connected.callTool({
      name: 'lore_read_source',
      arguments: { path: 'deployment.md', headingPath: ['Deployment', 'Rollback'] },
    });

    const read = result.structuredContent as { text: string; locator: { relativePath: string } };
    expect(read.text).toContain('roll back a release');
    expect(read.locator.relativePath).toBe('deployment.md');
  }, 120_000);
});

describe('the protocol era, over the transport a connector generates a config for', () => {
  /**
   * The regression #189 exists for.
   *
   * `lore mcp` hand-wired a `StdioServerTransport`, which never classifies the opening
   * message, so the connection stayed 2025-era and the mandatory `server/discover` probe
   * was answered with `Method not found`. Nothing caught it: the HTTP surface reaches the
   * modern era through `createMcpHandler`, and the raw-stdio tests sent a modern `_meta`
   * envelope that a legacy-era server simply ignores while answering normally.
   */
  it('negotiates the documented revision, and reports it on server/discover', async () => {
    const connected = await connect(['--ensure-current'], 'auto');
    const discovered = await connected.discover();

    expect(discovered.supportedVersions).toEqual([MCP_PROTOCOL_VERSION]);
  }, 120_000);

  it('serves the whole tool surface on the modern era, not only the handshake one', async () => {
    const connected = await connect(['--ensure-current'], 'auto');

    const listed = await connected.listTools();
    expect(listed.tools).toHaveLength(7);

    const result = await connected.callTool({
      name: 'lore_search',
      arguments: { query: 'rollback' },
    });
    const search = result.structuredContent as {
      hits: Array<{ locator: { relativePath: string } }>;
    };
    expect(search.hits[0]?.locator.relativePath).toBe('deployment.md');
  }, 120_000);

  /**
   * 2026-07-28 requires a server to keep serving 2025-era clients, and plenty of shipped
   * clients are exactly that. Losing this while fixing #189 would trade one broken client
   * population for another.
   */
  it('still serves a client that only speaks the removed handshake', async () => {
    const connected = await connect(['--ensure-current'], 'legacy');

    const listed = await connected.listTools();
    expect(listed.tools).toHaveLength(7);

    const result = await connected.callTool({
      name: 'lore_search',
      arguments: { query: 'rollback' },
    });
    const search = result.structuredContent as { hits: unknown[] };
    expect(search.hits.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('freshness, architecture 14.3', () => {
  it('rebuilds when the sources changed, so the first answer is current', async () => {
    const first = await connect(['--ensure-current']);
    const before = (
      (await first.callTool({ name: 'lore_build_info', arguments: {} })).structuredContent as {
        buildId: string;
      }
    ).buildId;
    await first.close();
    client = null;

    writeFileSync(
      join(project, 'deployment.md'),
      `${DOCUMENT}\n## Freeze\n\nNo deployments during a freeze.\n`,
      'utf8',
    );

    const second = await connect(['--ensure-current']);
    const after = (await second.callTool({ name: 'lore_build_info', arguments: {} }))
      .structuredContent as { buildId: string; sourceState: string };

    expect(after.buildId).not.toBe(before);
    expect(after.sourceState).toBe('clean');

    // And the new content is actually reachable, which is the point of rebuilding.
    const searched = await second.callTool({ name: 'lore_search', arguments: { query: 'freeze' } });
    expect((searched.structuredContent as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  }, 120_000);

  it('serves a dirty project under --allow-stale, and labels every result', async () => {
    const first = await connect(['--ensure-current']);
    await first.close();
    client = null;

    writeFileSync(join(project, 'extra.md'), '# Extra\n\nSomething new and unindexed.\n', 'utf8');

    const stale = await connect(['--allow-stale']);
    const info = (await stale.callTool({ name: 'lore_build_info', arguments: {} }))
      .structuredContent as { sourceState: string };

    expect(info.sourceState).toBe('dirty');
    // The stale build genuinely does not contain the new file, which is what dirty means.
    const searched = await stale.callTool({
      name: 'lore_search',
      arguments: { query: 'unindexed' },
    });
    expect((searched.structuredContent as { hits: unknown[] }).hits).toHaveLength(0);
  }, 120_000);

  it('does not look at the sources at all under --active-only', async () => {
    const first = await connect(['--ensure-current']);
    await first.close();
    client = null;

    writeFileSync(join(project, 'extra.md'), '# Extra\n\nStill unindexed.\n', 'utf8');

    const pinned = await connect(['--active-only']);
    const info = (await pinned.callTool({ name: 'lore_build_info', arguments: {} }))
      .structuredContent as { sourceState: string };

    // Not "clean" and not "dirty": nothing was checked, and the contract has a word for that.
    expect(info.sourceState).toBe('unknown');
  }, 120_000);
});

describe('stdout carries protocol and nothing else, architecture 14.3', () => {
  it('stays pure JSON-RPC even while a build is reporting progress', async () => {
    // The build happens during startup and prints stage lines. If any of them reached
    // stdout the client would see a parse error it could not explain, so this drives the
    // process directly and reads both streams rather than trusting the client to notice.
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(
        join(project, `doc-${index}.md`),
        `# Doc ${index}\n\nRollback notes.\n`,
        'utf8',
      );
    }

    const child = spawn(process.execPath, [BINARY, '--cwd', project, 'mcp', '--ensure-current'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (out.includes('"result"') || Date.now() - started > 90_000) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });
    child.kill('SIGTERM');

    const lines = out.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `stdout line is not a protocol frame: ${line}`).not.toThrow();
    }
    // And the progress really did happen, on the stream it belongs on.
    expect(err).toMatch(/Building|Parsing|Sources/);
  }, 120_000);
});

describe('shutting down', () => {
  /**
   * Both defects here were found by running the server by hand after every test passed.
   *
   * The first: the await on the transport closing never settled when standard input ended,
   * so Node printed "Detected unsettled top-level await" into the agent's log, which reads
   * as a defect in Lorepack. The second was hiding behind it: once the process could exit
   * cleanly, `close()` ran twice and the second call reached a closed database and ended a
   * working session with a stack trace.
   */
  it('exits cleanly when the client closes the pipe, with nothing alarming on stderr', async () => {
    const child = spawn(process.execPath, [BINARY, '--cwd', project, 'mcp', '--ensure-current'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      })}\n`,
    );

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (out.includes('"result"') || Date.now() - started > 90_000) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });

    // The client goes away by closing the pipe, which is what a client actually does.
    child.stdin.end();
    const code = await new Promise<number>((resolve) => {
      const give = setTimeout(() => resolve(-1), 30_000);
      child.once('exit', (value) => {
        clearTimeout(give);
        resolve(value ?? 0);
      });
    });

    expect(code).toBe(0);
    expect(err).not.toMatch(/unsettled top-level await/i);
    expect(err).not.toMatch(/database is not open|ERR_INVALID_STATE/);
    expect(err).not.toMatch(/^\s+at .*\(/m);
  }, 120_000);
});
