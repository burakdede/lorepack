import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { searchResultSchema, sourceListResultSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
const FILES = {
  'lore.yaml': 'version: 1\nname: anchored\nsources: [docs]\n',
  '.loreignore': '/docs/private/\n',
  'docs/public/p.md': '# Public\n\nPublicnarwhal is available.\n',
  'docs/private/p.md': '# Private\n\nPrivatewalrus is excluded.\n',
};

async function cli(root: string, args: readonly string[]) {
  return run(process.execPath, [BINARY, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

it('applies project exclusions to deterministic builds and real CLI, HTTP and MCP reads, issue588', async () => {
  await withTempProject({ files: FILES }, async (project) => {
    const built = JSON.parse((await cli(project.root, ['build'])).stdout) as { buildId: string };
    expect(built.buildId).toMatch(/^lore_[a-f0-9]{64}$/);
    await withTempProject({ files: FILES }, async (other) => {
      const again = JSON.parse((await cli(other.root, ['build'])).stdout) as { buildId: string };
      expect(again.buildId).toBe(built.buildId);
    });

    const visible = searchResultSchema.parse(
      JSON.parse((await cli(project.root, ['search', 'publicnarwhal'])).stdout),
    );
    expect(visible.buildId).toBe(built.buildId);
    expect(visible.hits[0]?.locator).toMatchObject({
      artifactId: 'docs:public/p.md',
      relativePath: 'public/p.md',
    });
    const excluded = searchResultSchema.parse(
      JSON.parse((await cli(project.root, ['search', 'privatewalrus'])).stdout),
    );
    expect(excluded.hits).toEqual([]);

    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const address = socket.address();
    if (address === null || typeof address === 'string') throw new Error('Missing port.');
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const server = spawn(process.execPath, [BINARY, 'serve', '--port', String(port)], {
      cwd: project.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const base = `http://127.0.0.1:${port}`;
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client(
      { name: 'lorepack-ignore-check', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      const deadline = Date.now() + 30_000;
      while (!output.includes('REST') && server.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toContain('REST');
      const inventoryResponse = await fetch(`${base}/v1/sources`);
      expect(inventoryResponse.status).toBe(200);
      const inventory = sourceListResultSchema.parse(await inventoryResponse.json());
      expect(inventory.buildId).toBe(built.buildId);
      expect(inventory.artifacts.map((artifact) => artifact.artifactId)).toEqual([
        'docs:public/p.md',
      ]);
      expect(inventory.artifacts[0]?.locator.relativePath).toBe('public/p.md');

      for (const [query, included] of [
        ['publicnarwhal', true],
        ['privatewalrus', false],
      ] as const) {
        const response = await fetch(`${base}/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        expect(response.status).toBe(200);
        const answer = searchResultSchema.parse(await response.json());
        expect(answer.buildId).toBe(built.buildId);
        if (included) expect(answer.hits[0]?.locator.artifactId).toBe('docs:public/p.md');
        else expect(answer.hits).toEqual([]);
      }
      const missing = await fetch(`${base}/v1/sources/${encodeURIComponent('docs:private/p.md')}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: 'LORE_E_BUILD_NOT_FOUND' } });

      await client.connect(transport);
      const mcpInventory = sourceListResultSchema.parse(
        (await client.callTool({ name: 'lore_list_sources', arguments: {} })).structuredContent,
      );
      expect(mcpInventory.artifacts.map((artifact) => artifact.artifactId)).toEqual([
        'docs:public/p.md',
      ]);
      for (const [query, included] of [
        ['publicnarwhal', true],
        ['privatewalrus', false],
      ] as const) {
        const answer = searchResultSchema.parse(
          (await client.callTool({ name: 'lore_search', arguments: { query } })).structuredContent,
        );
        expect(answer.buildId).toBe(built.buildId);
        if (included) expect(answer.hits[0]?.locator.relativePath).toBe('public/p.md');
        else expect(answer.hits).toEqual([]);
      }
      const missingMcp = await client.callTool({
        name: 'lore_read_source',
        arguments: { artifactId: 'docs:private/p.md' },
      });
      expect(missingMcp.isError).toBe(true);
      expect(JSON.stringify(missingMcp)).toContain('LORE_E_BUILD_NOT_FOUND');
      expect(JSON.stringify(missingMcp)).not.toContain('Privatewalrus');
    } finally {
      try {
        await client.close();
      } finally {
        try {
          await transport.close();
        } finally {
          await stop(server);
        }
      }
    }
  });
}, 180_000);
