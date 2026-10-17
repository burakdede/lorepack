import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertBuildId, searchResultSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function cli(root: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await execute(process.execPath, [BINARY, '--cwd', root, '--json', ...args], {
    timeout: 30_000,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function build(root: string) {
  const result = await cli(root, ['build']);
  if (typeof result.buildId !== 'string') throw new Error('CLI build returned no build ID.');
  return assertBuildId(result.buildId);
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

it.each(['http', 'mcp'] as const)(
  'prunes an idle %s catalog after external activation before another request, issue566',
  async (protocol) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: idle\nsources: [docs]\n',
          'docs/a.md': '# Recovery\n\nRestore the original recovery checkpoint.\n',
        },
      },
      async (temp) => {
        const first = await build(temp.root);
        const child = spawn(
          process.execPath,
          [BINARY, '--cwd', temp.root, 'serve', '--port', protocol === 'http' ? '47991' : '47992'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          output += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          output += chunk;
        });
        let client: Client | null = null;
        try {
          const ready = Date.now() + 30_000;
          while (!output.includes('REST') && child.exitCode === null && Date.now() < ready) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const base = /REST\s+(http:\/\/[^\s]+)\/v1/.exec(output)?.[1];
          expect(base, output).toBeDefined();
          if (protocol === 'mcp') {
            client = new Client(
              { name: 'idle-prune-test', version: '1' },
              { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            );
            await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
          }
          const read = async () => {
            if (client !== null) {
              return searchResultSchema.parse(
                (
                  await client.callTool({
                    name: 'lore_search',
                    arguments: { query: 'recovery' },
                  })
                ).structuredContent,
              );
            }
            const response = await fetch(`${base}/v1/search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: 'recovery' }),
            });
            expect(response.status).toBe(200);
            return searchResultSchema.parse(await response.json());
          };
          const initial = await read();
          expect(initial.buildId).toBe(first);
          expect(initial.hits.length).toBeGreaterThan(0);
          writeFileSync(
            temp.path('docs/a.md'),
            '# Recovery\n\nRestart the reviewed recovery worker.\n',
          );
          const second = await build(temp.root);
          expect(second).not.toBe(first);

          // No further server request may release an idle catalog before this actual prune.
          const pruned = await cli(temp.root, ['prune', '--keep', '0', '--yes']);
          expect(pruned.remove, JSON.stringify(pruned)).toContain(first);
          expect(existsSync(temp.path(`.lore/builds/${first}`))).toBe(false);
          expect(existsSync(temp.path(`.lore/builds/${second}`))).toBe(true);
          expect(child.exitCode).toBeNull();
          const next = await read();
          expect(next.buildId).toBe(second);
          expect(next.hits.some((hit) => hit.locator.relativePath === 'a.md')).toBe(true);
        } finally {
          try {
            await client?.close();
          } finally {
            await stop(child);
          }
        }
      },
    );
  },
);
