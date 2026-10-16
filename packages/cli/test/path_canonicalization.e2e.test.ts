import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readArchive } from '@lorepack/backend-local';
import { searchResultSchema, sourceListResultSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
function files(spelling = 'cafe\u0301'): Record<string, string> {
  return {
    'lore.yaml': `version: 1\nname: normalized\nsources: [docs]\nstrictRules: true\nrules:\n  - match: "${spelling}/current.md"\n    authority: 90\n    supersedes: ["${spelling}/old.md"]\n`,
    '.loreignore': `${spelling}-secret.md\n`,
    'docs/café/current.md': '# Public\n\nPublicnarwhal is available.\n',
    'docs/café/old.md': '# Old\n\nPrevious policy.\n',
    'docs/..notes.md': '# Notes\n\nQuokka notes are retained.\n',
    'docs/café-secret.md': '# Private\n\nPrivatewalrus is excluded.\n',
  };
}

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

it('normalizes patterns and valid dot-dot paths through actual CLI, HTTP and MCP, issue589', async () => {
  await withTempProject({ files: files() }, async (project) => {
    const built = JSON.parse((await cli(project.root, ['build'])).stdout) as { buildId: string };
    expect(built.buildId).toMatch(/^lore_[a-f0-9]{64}$/);
    await withTempProject({ files: files('café') }, async (other) => {
      const again = JSON.parse((await cli(other.root, ['build'])).stdout) as { buildId: string };
      expect(again.buildId).toBe(built.buildId);
    });

    const archive = project.path('policy2.lorepack');
    await cli(project.root, ['pack', '--out', archive]);
    const members = await readArchive(archive);
    const recorded = members.get('reports/build-id-inputs.json');
    expect(recorded).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(recorded))).toMatchObject({
      normalizationVersion: 2,
    });

    const visible = searchResultSchema.parse(
      JSON.parse((await cli(project.root, ['search', 'publicnarwhal'])).stdout),
    );
    expect(visible.buildId).toBe(built.buildId);
    expect(visible.hits[0]?.locator).toMatchObject({
      artifactId: 'docs:café/current.md',
      relativePath: 'café/current.md',
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
        'docs:..notes.md',
        'docs:café/current.md',
        'docs:café/old.md',
      ]);
      expect(
        inventory.artifacts.find((artifact) => artifact.locator.relativePath === 'café/current.md'),
      ).toMatchObject({ authority: 90 });

      for (const [query, included, relativePath] of [
        ['publicnarwhal', true, 'café/current.md'],
        ['quokka', true, '..notes.md'],
        ['privatewalrus', false, null],
      ] as const) {
        const response = await fetch(`${base}/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        expect(response.status).toBe(200);
        const answer = searchResultSchema.parse(await response.json());
        expect(answer.buildId).toBe(built.buildId);
        if (included) expect(answer.hits[0]?.locator.relativePath).toBe(relativePath);
        else expect(answer.hits).toEqual([]);
      }
      const missing = await fetch(
        `${base}/v1/sources/${encodeURIComponent('docs:café-secret.md')}`,
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: 'LORE_E_BUILD_NOT_FOUND' } });

      await client.connect(transport);
      const mcpInventory = sourceListResultSchema.parse(
        (await client.callTool({ name: 'lore_list_sources', arguments: {} })).structuredContent,
      );
      expect(mcpInventory.artifacts.map((artifact) => artifact.artifactId)).toEqual([
        'docs:..notes.md',
        'docs:café/current.md',
        'docs:café/old.md',
      ]);
      for (const [query, included, relativePath] of [
        ['publicnarwhal', true, 'café/current.md'],
        ['quokka', true, '..notes.md'],
        ['privatewalrus', false, null],
      ] as const) {
        const answer = searchResultSchema.parse(
          (await client.callTool({ name: 'lore_search', arguments: { query } })).structuredContent,
        );
        expect(answer.buildId).toBe(built.buildId);
        if (included) expect(answer.hits[0]?.locator.relativePath).toBe(relativePath);
        else expect(answer.hits).toEqual([]);
      }
      const missingMcp = await client.callTool({
        name: 'lore_read_source',
        arguments: { artifactId: 'docs:café-secret.md' },
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

// Linux and Windows retain both spellings; normalization-insensitive APFS cannot.
it.skipIf(process.platform === 'darwin')(
  'refuses real canonical collisions without changing the active build',
  async () => {
    await withTempProject({ files: files() }, async (project) => {
      const before = JSON.parse((await cli(project.root, ['build'])).stdout) as { buildId: string };
      writeFileSync(join(project.root, 'docs', 'café.md'), '# One');
      writeFileSync(join(project.root, 'docs', 'cafe\u0301.md'), '# Two');
      expect(readdirSync(join(project.root, 'docs'))).toEqual(
        expect.arrayContaining(['café.md', 'cafe\u0301.md']),
      );
      let rejected = false;
      try {
        await cli(project.root, ['build']);
      } catch (error) {
        rejected = true;
        expect(JSON.stringify(error)).toContain('LORE_E_CASE_COLLISION');
        expect(JSON.stringify(error)).toContain('café.md');
        expect(JSON.stringify(error)).toContain('cafe\u0301.md');
      }
      expect(rejected).toBe(true);
      const after = JSON.parse((await cli(project.root, ['status'])).stdout) as {
        activeBuildId: string;
      };
      expect(after.activeBuildId).toBe(before.buildId);
    });
  },
  180_000,
);

// Windows named pipes are not POSIX filesystem socket entries.
it.skipIf(process.platform === 'win32')(
  'reports a special entry through actual build and inspect warnings',
  async () => {
    await withTempProject({ files: files() }, async (project) => {
      const socket = createServer();
      socket.listen(join(project.root, 'docs', 'channel.sock'));
      await once(socket, 'listening');
      try {
        await cli(project.root, ['build']);
        const report = JSON.parse((await cli(project.root, ['inspect', 'warnings'])).stdout) as {
          warnings: unknown[];
        };
        expect(report.warnings).toContainEqual(
          expect.objectContaining({
            code: 'special-file',
            class: 'unsupported-file',
            path: 'docs/channel.sock',
          }),
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
  180_000,
);
