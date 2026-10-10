import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The local server's request guards, attacked the way a hostile web page would (#547, #548).
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

/**
 * Cross-site request forgery from another localhost page (#548).
 *
 * The request a page on `http://localhost:8080` can make with `mode: 'no-cors'`: a `text/plain`
 * body, its own `Origin`, and the server's real `Host`. Before the fix it overwrote any file the
 * user could write with a ZIP archive.
 */
describe('another localhost page cannot write through the local server (#548)', () => {
  it('cannot pack over a file of its choosing, with or without a preflight-free body', async () => {
    const victim = join(project, '..', `lore-victim-${PORT}.txt`);
    writeFileSync(victim, 'precious\n', 'utf8');
    try {
      for (const type of ['text/plain', 'application/json']) {
        const answer = await send('/v1/builds/pack', {
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${PORT}`,
            Origin: 'http://localhost:8080',
            'Content-Type': type,
          },
          body: JSON.stringify({ out: victim }),
        });
        expect(answer.status, type).toBe(403);
      }
      // A page that does share the origin still cannot send a preflight-free body.
      const simple = await send('/v1/builds/pack', {
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${PORT}`,
          Origin: `http://127.0.0.1:${PORT}`,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      });
      expect(simple.status).toBe(415);
      // Even a caller with no Origin at all, which the guard admits, cannot name the file.
      const direct = await send('/v1/builds/pack', {
        method: 'POST',
        headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ out: victim }),
      });
      expect(direct.status).toBe(400);
      expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    } finally {
      rmSync(victim, { force: true });
    }
  });

  it.each(['/v1/builds/activate', '/v1/builds/rollback'])(
    'refuses %s from a localhost page on another port',
    async (path) => {
      for (const type of ['text/plain', 'application/json']) {
        const answer = await send(path, {
          method: 'POST',
          headers: {
            Host: `127.0.0.1:${PORT}`,
            Origin: 'http://localhost:8080',
            'Content-Type': type,
          },
          body: JSON.stringify({ build: 'lore_0' }),
        });
        expect(answer.status, type).toBe(403);
      }
    },
  );

  it('still lets Studio, which is same-origin, pack to the default place', async () => {
    const answer = await send('/v1/builds/pack', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(answer.status, answer.body).toBe(200);
    const archive = (JSON.parse(answer.body) as { archive: string }).archive;
    expect(archive).toMatch(/\.lorepack$/);
    expect(existsSync(archive)).toBe(true);
  });
});
