import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalStateStore, stateMigrationsDirectory } from '@lorepack/backend-local';
import { loadProjectConfig, type RuntimeIdentity } from '@lorepack/core';
import { LEGACY_HANDSHAKE_VERSIONS, MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { startServing } from '../src/services/serving.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function cli(root: string, args: string[]) {
  return execute(process.execPath, [BIN, '--cwd', root, '--json', ...args], {
    timeout: 30_000,
  });
}

async function retainedProject(
  body: (root: string, first: string, second: string, identity: RuntimeIdentity) => Promise<void>,
) {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: retained\nsources:\n  - docs\n',
        'docs/a.md': '# Recovery\n\nOriginal recovery procedure: restore the checkpoint.\n',
      },
    },
    async (temp) => {
      const first = JSON.parse((await cli(temp.root, ['build'])).stdout).buildId as string;
      writeFileSync(
        temp.path('docs/a.md'),
        '# Recovery\n\nReplacement recovery procedure: restart the worker.\n',
      );
      const second = JSON.parse((await cli(temp.root, ['build'])).stdout).buildId as string;
      expect(second).not.toBe(first);
      rmSync(temp.path('docs'), { recursive: true });
      rmSync(temp.path('.lore/cache'), { recursive: true, force: true });
      const state = LocalStateStore.open(temp.path('.lore'), stateMigrationsDirectory());
      let identity: RuntimeIdentity;
      try {
        identity = state.identity();
      } finally {
        state.close();
      }
      await body(temp.root, first, second, identity);
    },
  );
}

async function stop(child: ChildProcess, signal = false) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Retained server did not stop.'));
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    if (signal) child.kill('SIGTERM');
    else child.stdin?.end();
  });
}

async function rpc(child: ChildProcess, id: number, method: string, params: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error(`MCP ${method} timed out.`)), 10_000);
    const finish = (error: Error | null, result?: unknown) => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      if (error !== null) reject(error);
      else resolve(result);
    };
    const onExit = () => finish(new Error(`MCP exited during ${method}.`));
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line) as { id?: number; error?: unknown; result?: unknown };
        if (message.id === id) {
          finish(
            message.error === undefined ? null : new Error(JSON.stringify(message.error)),
            message.result,
          );
        }
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

describe('retained builds without live sources', () => {
  it('restarts the packaged read-only HTTP server after source removal', async () => {
    await retainedProject(async (root, _first, second) => {
      const child = spawn(process.execPath, [BIN, '--cwd', root, 'serve', '--port', '47980'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!output.includes('REST') && child.exitCode === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(output).toContain('REST');
        const url = /REST\s+(http:\/\/[^\s]+)\/v1/.exec(output)?.[1];
        expect(url).toBeDefined();
        const response = await fetch(`${url}/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'recovery' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ buildId: second, sourceState: 'unknown' });
      } finally {
        await stop(child, true);
      }
    });
  });

  it('serves retained HTTP evidence and rolls back through the Studio operation', async () => {
    await retainedProject(async (root, first, second, identity) => {
      const config = loadProjectConfig({ cwd: root });
      const server = await startServing({
        config,
        host: '127.0.0.1',
        port: 47_970,
        studio: true,
        warn: () => {},
        revalidateIntervalMs: 0,
      });
      try {
        const search = () =>
          fetch(`${server.url}/v1/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'recovery' }),
          });
        const before = await search();
        expect(before.status).toBe(200);
        expect(await before.json()).toMatchObject({
          ...identity,
          buildId: second,
          sourceState: 'unknown',
        });
        const rolled = await fetch(`${server.url}/v1/builds/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: server.url },
          body: JSON.stringify({ expect: first }),
        });
        expect(rolled.status).toBe(200);
        expect(await rolled.json()).toMatchObject({ buildId: first });
        const after = await search();
        expect(after.status).toBe(200);
        const result = await after.json();
        expect(result).toMatchObject(identity);
        expect(JSON.stringify(result)).toContain('restore the checkpoint');
        const denied = await fetch(`${server.url}/v1/builds/rollback`, { method: 'POST' });
        expect(denied.status).not.toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  it.each(
    ['--active-only', '--allow-stale'].flatMap((mode) =>
      ['modern', 'legacy'].map((era) => ({ mode, era })),
    ),
  )('serves retained MCP evidence with $mode in the $era era', async ({ mode, era }) => {
    await retainedProject(async (root, _first, second, identity) => {
      const child = spawn(process.execPath, [BIN, '--cwd', root, 'mcp', mode], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      try {
        const envelope = {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
        };
        if (era === 'modern') {
          const discovered = await rpc(child, 1, 'server/discover', { _meta: envelope });
          expect(discovered).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION] });
        } else {
          await rpc(child, 1, 'initialize', {
            protocolVersion: LEGACY_HANDSHAKE_VERSIONS[0],
            capabilities: {},
            clientInfo: { name: 'retained-test', version: '1' },
          });
          child.stdin?.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
        }
        const result = JSON.stringify(
          await rpc(child, 2, 'tools/call', {
            name: 'lore_search',
            arguments: { query: 'recovery' },
            ...(era === 'modern' ? { _meta: envelope } : {}),
          }),
        );
        expect(result, diagnostics).toContain(second);
        expect(result).toContain('restart the worker');
        expect(result).toContain('unknown');
        expect(result).toContain(identity.corpusId);
        expect(result).toContain(identity.namespaceId);
      } finally {
        await stop(child);
      }
    });
  });

  it('rolls back and reads, compares, packs and reactivates through the packaged CLI', async () => {
    await retainedProject(async (root, first, second, identity) => {
      const rollback = JSON.parse((await cli(root, ['rollback', first])).stdout);
      expect(rollback.buildId).toBe(first);
      for (const args of [
        ['builds'],
        ['inspect', 'build'],
        ['inspect', 'sources'],
        ['inspect', 'warnings'],
        ['inspect', 'exclusions'],
        ['inspect', 'chunks'],
        ['inspect', 'tables'],
        ['diff', first, second],
        ['search', 'recovery'],
        ['export', '--task', 'recovery procedure', '--format', 'json'],
        ['pack', '--out', join(root, 'retained.lorepack')],
        ['prune', '--keep', '2'],
      ]) {
        const result = await cli(root, args);
        expect(result.stdout, args.join(' ')).not.toBe('');
        if (args[0] === 'search' || args[0] === 'export') {
          expect(result.stdout).toContain('restore the checkpoint');
          expect(result.stdout).toContain('unknown');
          expect(result.stdout).toContain(identity.corpusId);
          expect(result.stdout).toContain(identity.namespaceId);
        }
      }
      expect(JSON.parse((await cli(root, ['activate', second])).stdout).buildId).toBe(second);
      expect(JSON.parse((await cli(root, ['rollback'])).stdout).buildId).toBe(first);
      await expect(cli(root, ['build'])).rejects.toMatchObject({
        stdout: expect.stringContaining('Source path does not exist'),
      });
    });
  });

  it.each(['invalid', 'mismatched'])(
    'refuses a %s retained manifest while the active build remains readable',
    async (kind) => {
      await retainedProject(async (root, first, second) => {
        const manifestPath = join(root, '.lore', 'builds', first, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        writeFileSync(
          manifestPath,
          kind === 'invalid' ? '{}' : JSON.stringify({ ...manifest, buildId: second }),
        );
        await expect(cli(root, ['rollback', first])).rejects.toMatchObject({
          stdout: expect.stringContaining('LORE_E_BUILD_VALIDATION'),
        });
        const history = JSON.parse((await cli(root, ['builds'])).stdout);
        expect(history.activeBuildId).toBe(second);
        expect((await cli(root, ['search', 'recovery'])).stdout).toContain('restart the worker');
      });
    },
  );
});
