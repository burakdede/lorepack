import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The local server's request guards, attacked the way a hostile web page would (#547).
 *
 * Driven against the real `lorepack dev` binary over real sockets, because each attack depends
 * on a header a browser sets and `fetch` will not let a test forge: the `Host` a rebound page
 * sends names the attacker's domain while the socket connects to `127.0.0.1`.
 */

const BINARY = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'cli',
  'dist',
  'public-entry.js',
);
const SECRET = '# Secret plan\n\nThe launch date is the twelfth.\n';
/** Clear of the dev suite's 4700 range and the 43110 default, so neither collides. */
const PORT = 47_610;

let project: string;
let child: ChildProcess;
let output = '';

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** One HTTP request with exactly the headers given, including a forged `Host`. */
function send(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'lore-guard-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'secret.md'), SECRET, 'utf8');

  child = spawn(process.execPath, [BINARY, 'dev', project, '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const deadline = Date.now() + 90_000;
  while (!output.includes('MCP stdio') && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(output, `lorepack dev never started:\n${output}`).toContain('MCP stdio');
  expect(output, `lorepack dev moved off its port:\n${output}`).not.toContain('was busy');
}, 120_000);

afterAll(async () => {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const give = setTimeout(resolve, 10_000);
      child.once('exit', () => {
        clearTimeout(give);
        resolve(undefined);
      });
    });
  }
  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A leaked temporary directory must never fail a run that passed its assertions.
  }
});

describe('DNS rebinding: a foreign Host header reaches nothing (#547)', () => {
  it.each([
    ['GET', '/v1/sources/docs%2Fsecret.md'],
    ['GET', '/v1/sources'],
    ['GET', '/v1/diagnostics'],
    ['GET', '/v1/builds'],
    ['GET', '/health'],
    ['POST', '/mcp'],
  ])('refuses %s %s with Host: attacker.example', async (method, path) => {
    const answer = await send(path, {
      method,
      headers: {
        Host: `attacker.example:${PORT}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

    expect(answer.status).toBe(403);
    expect(answer.body).not.toContain('launch date');
    expect(answer.body).not.toContain(project);
  });

  it('still answers the same read on a loopback name, so the guard is not refusing everything', async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const answer = await send('/v1/sources/docs%2Fsecret.md', { headers: { Host: host } });
      expect(answer.status, host).toBe(200);
      expect(answer.body).toContain('launch date');
    }
  });
});
