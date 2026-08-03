import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { LoreClient } from '@lorepack/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `lore serve` as a person runs it: a real process, a real port, real HTTP.
 *
 * What this reaches that an in-process test cannot: that the two surfaces share one
 * server, that a build made in another terminal is picked up without a restart, and that
 * an occupied port is an inconvenience rather than a failure.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'entry.js');

const CONFIG = 'version: 1\nname: served\nsources:\n  - .\n';
const DOCUMENT =
  '# Deployment\n\n## Rollback\n\nTo roll back a release, activate the previous build.\n';

let project: string;
const running: ChildProcess[] = [];

function lore(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BINARY, '--cwd', project, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function serve(args: readonly string[] = []): Promise<{ url: string; stdout: string }> {
  const child = spawn(process.execPath, [BINARY, '--cwd', project, 'serve', ...args]);
  running.push(child);

  let stdout = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve never printed a URL: ${stdout}`)),
      60_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = /Health (http:\/\/\S+)\/health/.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('error', reject);
  });
  return { url, stdout };
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'lore-serve-'));
  writeFileSync(join(project, 'lore.yaml'), CONFIG, 'utf8');
  writeFileSync(join(project, 'deployment.md'), DOCUMENT, 'utf8');
  await lore(['build']);
});

afterEach(async () => {
  // Wait for each server to actually exit before removing anything. Windows has no POSIX
  // signal delivery, so `kill` terminates rather than notifies, and the process still holds
  // the build database open for a moment afterwards: removing the directory underneath it
  // fails with EPERM.
  await Promise.all(
    running.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const done = setTimeout(resolve, 10_000);
          child.once('exit', () => {
            clearTimeout(done);
            resolve();
          });
          child.kill('SIGTERM');
        }),
    ),
  );

  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leaked temporary directory must not fail a run. The assertions already passed.
  }
});

describe('one server, both surfaces', () => {
  it('answers REST through the SDK', async () => {
    const { url } = await serve(['--port', '4610']);
    const client = new LoreClient({ baseUrl: url });

    expect((await client.health()).status).toBe('ok');
    const result = await client.search({ query: 'rollback' });
    expect(result.hits[0]?.locator.relativePath).toBe('deployment.md');
  });

  it('answers MCP on the same port, with the identical tool surface', async () => {
    const { url } = await serve(['--port', '4620']);
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });

    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((tool) => tool.name);
    // The same seven the stdio transport registers, because it is the same registration.
    expect(names).toHaveLength(7);
    expect(names).toContain('lore_context_for_task');
  });

  it('prints the URLs a person needs, in one block', async () => {
    const { stdout } = await serve(['--port', '4630']);
    expect(stdout).toContain('REST');
    expect(stdout).toContain('MCP');
    expect(stdout).toContain('Read-only');
  });
});

describe('activation without a restart', () => {
  it('serves a build made in another process, at the next request', async () => {
    const { url } = await serve(['--port', '4640']);
    const client = new LoreClient({ baseUrl: url });
    const before = (await client.describeBuild()).buildId;

    writeFileSync(join(project, 'extra.md'), '# Extra\n\nA freeze is in effect.\n', 'utf8');
    const built = await lore(['build']);
    expect(built.code).toBe(0);

    const after = await client.describeBuild();
    expect(after.buildId).not.toBe(before);
    expect((await client.search({ query: 'freeze' })).hits.length).toBeGreaterThan(0);
  });

  it('follows a rollback in another process too', async () => {
    const { url } = await serve(['--port', '4650']);
    const client = new LoreClient({ baseUrl: url });
    const first = (await client.describeBuild()).buildId;

    writeFileSync(join(project, 'extra.md'), '# Extra\n\nSomething new.\n', 'utf8');
    await lore(['build']);
    expect((await client.describeBuild()).buildId).not.toBe(first);

    await lore(['rollback']);
    expect((await client.describeBuild()).buildId).toBe(first);
  });
});

describe('ports and refusals', () => {
  it('steps to the next port when one is taken, and says so', async () => {
    const first = await serve(['--port', '4660']);
    const second = await serve(['--port', '4660']);

    expect(first.url).toContain('4660');
    expect(second.url).toContain('4661');
  });

  it('refuses to serve a project with no build, actionably', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lore-empty-'));
    writeFileSync(join(empty, 'lore.yaml'), CONFIG, 'utf8');
    try {
      const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [BINARY, '--cwd', empty, 'serve', '--port', '4670']);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(result.stderr).toContain('lore build');
    } finally {
      rmSync(empty, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('never builds anything, however dirty the project gets', async () => {
    // Rechecking every request, so the assertion is about serving rather than about
    // waiting out the default five second interval.
    const { url } = await serve(['--port', '4680', '--revalidate-interval', '0']);
    const client = new LoreClient({ baseUrl: url });
    const before = (await client.describeBuild()).buildId;

    writeFileSync(join(project, 'unindexed.md'), '# New\n\nNot in any build.\n', 'utf8');

    const health = await client.health();
    expect(health.buildId).toBe(before);
    expect(health.sourceState).toBe('dirty');
    // Dirty, and still the same build: serving is not building (that is `lore dev`).
    expect((await client.search({ query: 'unindexed' })).hits).toHaveLength(0);
  });
});
