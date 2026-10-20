import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDescriptionSchema, searchResultSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

async function waitFor(check: () => boolean, context: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(check(), context()).toBe(true);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

it('serves HTTP, MCP and Studio while a rebuild stalls in a synchronous report write, issue778', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: responsive\nsources: [docs]\n',
        'docs/a.md': '# Recovery\n\nRestore the reviewed checkpoint.\n',
      },
    },
    async (project) => {
      const armed = project.path('stall.armed');
      const began = project.path('stall.began');
      const ended = project.path('stall.ended');
      const preload = project.path('slow_report_fsync.mjs');
      writeFileSync(
        preload,
        `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isMainThread, threadId } from 'node:worker_threads';
const opened = new Map();
const open = fs.openSync, close = fs.closeSync, fsync = fs.fsyncSync;
fs.openSync = (path, ...args) => {
  const fd = open(path, ...args);
  opened.set(fd, String(path));
  return fd;
};
fs.closeSync = (fd) => { opened.delete(fd); return close(fd); };
fs.fsyncSync = (fd) => {
  const path = opened.get(fd);
  if (path && /[\\\\/]reports[\\\\/]/.test(path) &&
      fs.existsSync(${JSON.stringify(armed)}) && !fs.existsSync(${JSON.stringify(began)})) {
    fs.writeFileSync(${JSON.stringify(began)}, JSON.stringify({ pid: process.pid, isMainThread, threadId, path }));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_500);
    fs.writeFileSync(${JSON.stringify(ended)}, 'done');
  }
  return fsync(fd);
};
syncBuiltinESMExports();
`,
      );
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const address = reservation.address();
      if (address === null || typeof address === 'string') throw new Error('No test port.');
      const port = address.port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const base = `http://127.0.0.1:${port}`;
      const child = spawn(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          join(import.meta.dirname, '../dist/public-entry.js'),
          'dev',
          project.root,
          '--port',
          String(port),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        output += data.toString();
      });
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const read = (path: string, body?: unknown) =>
        new Promise<{
          status: number | undefined;
          reused: boolean;
          text: string;
        }>((resolve, reject) => {
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const req = request(
            `${base}${path}`,
            {
              agent,
              method: payload === undefined ? 'GET' : 'POST',
              headers: payload === undefined ? {} : { 'content-type': 'application/json' },
            },
            (res) => {
              let text = '';
              res.on('data', (data: Buffer) => {
                text += data.toString();
              });
              res.once('error', reject);
              res.once('end', () =>
                resolve({ status: res.statusCode, reused: req.reusedSocket, text }),
              );
            },
          );
          req.once('error', reject);
          req.end(payload);
        });
      const client = new Client(
        { name: 'rebuild-stall-test', version: '0.1.0' },
        {
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        },
      );
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      try {
        await waitFor(
          () => output.includes('MCP stdio'),
          () => output,
        );
        await client.connect(transport);
        const warm = await read('/v1/build');
        expect(warm.status, output).toBe(200);
        const first = buildDescriptionSchema.parse(JSON.parse(warm.text)).buildId;
        writeFileSync(armed, 'armed');
        project.write('docs/a.md', '# Recovery\n\nUse the newly built checkpoint.\n');
        await waitFor(
          () => existsSync(began),
          () => output,
        );
        const duringWarm = await read('/v1/build');
        expect(duringWarm.status, output).toBe(200);
        expect(buildDescriptionSchema.parse(JSON.parse(duringWarm.text)).buildId).toBe(first);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const during = await read('/v1/build');
        expect(during.status, output).toBe(200);
        expect(during.reused).toBe(true);
        expect(buildDescriptionSchema.parse(JSON.parse(during.text)).buildId).toBe(first);
        const http = await read('/v1/search', { query: 'checkpoint' });
        expect(http.status, output).toBe(200);
        expect(searchResultSchema.parse(JSON.parse(http.text)).buildId).toBe(first);
        const mcp = searchResultSchema.parse(
          (
            await client.callTool({
              name: 'lore_search',
              arguments: { query: 'checkpoint' },
            })
          ).structuredContent,
        );
        expect(mcp.buildId).toBe(first);
        expect(mcp.hits[0]?.excerpt).toContain('Restore the reviewed [checkpoint].');
        const studio = await read('/');
        expect(studio.status, output).toBe(200);
        expect(studio.text).toContain('<html');
        expect(existsSync(ended)).toBe(false);
        const stall = JSON.parse(readFileSync(began, 'utf8')) as { isMainThread: boolean };
        expect(stall.isMainThread).toBe(false);
        await waitFor(
          () => existsSync(ended),
          () => output,
        );
        let final = first;
        const deadline = Date.now() + 30_000;
        while (final === first && Date.now() < deadline) {
          final = buildDescriptionSchema.parse(JSON.parse((await read('/v1/build')).text)).buildId;
          if (final === first) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(final, output).not.toBe(first);
        expect(
          searchResultSchema.parse(
            (
              await client.callTool({
                name: 'lore_search',
                arguments: { query: 'checkpoint' },
              })
            ).structuredContent,
          ).buildId,
        ).toBe(final);
      } finally {
        agent.destroy();
        await client.close();
        await transport.close();
        await stop(child);
      }
    },
  );
}, 90_000);
