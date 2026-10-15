import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { openReadOnly } from '../src/sqlite.js';
import { LocalStateStore } from '../src/state-store.js';

const PACKAGE = join(import.meta.dirname, '..');
const COMPILED = pathToFileURL(join(PACKAGE, 'dist/index.js')).href;
const MIGRATIONS = join(PACKAGE, 'migrations/state');

async function coordinatedOpen(directory: string, count: number) {
  const script = `
    const { LocalStateStore } = await import(${JSON.stringify(COMPILED)});
    process.stdin.once('data', () => {
      const started = performance.now();
      try {
        const store = LocalStateStore.open(${JSON.stringify(directory)}, ${JSON.stringify(MIGRATIONS)});
        const identity = store.identity();
        store.close();
        process.stdout.write(JSON.stringify({ ok: true, identity, elapsedMs: performance.now() - started }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, elapsedMs: performance.now() - started,
          message: error?.message, stack: error?.stack, code: error?.code, errcode: error?.errcode,
          cause: error?.cause?.message, causeStack: error?.cause?.stack }) + '\\n');
        process.exitCode = 1;
      }
      process.stdin.destroy();
    });
    process.stdout.write('ready\\n');`;
  const children = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('ready\n')) resolve();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', () => {
        if (!output.includes('ready\n'))
          reject(new Error(`Opener exited before readiness: ${output} ${stderr}`));
      });
    });
    const done = new Promise<{ code: number | null; output: string; stderr: string }>((resolve) => {
      child.once('close', (code) => resolve({ code, output, stderr }));
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map((entry) => entry.ready));
    for (const { child } of children) child.stdin.end('open\n');
    return await Promise.all(children.map((entry) => entry.done));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

it('opens cold state when six prepared processes enter together across ten projects', async () => {
  await withTempProject({}, async (project) => {
    const failures: unknown[] = [];
    for (let trial = 0; trial < 10; trial += 1) {
      const directory = project.path(`cold-${trial}/.lore`);
      mkdirSync(directory, { recursive: true });
      const results = await coordinatedOpen(directory, 6);
      expect(results).toHaveLength(6);
      for (const result of results) {
        const line = result.output.trim().split('\n').at(-1);
        if (line === undefined) throw new Error(`Opener did not report a result: ${result.stderr}`);
        const reply = JSON.parse(line) as { ok: boolean; elapsedMs: number };
        if (result.code !== 0 || reply.ok !== true) failures.push({ trial, ...result, reply });
      }
    }
    expect(failures).toEqual([]);
  });
}, 120_000);

it('lets five cold peers finish while another initializer is paused before its first schema write', async () => {
  await withTempProject({}, async (project) => {
    const directory = project.path('.lore');
    mkdirSync(directory);
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { readSync } from 'node:fs';
      const original = DatabaseSync.prototype.exec;
      let paused = false;
      DatabaseSync.prototype.exec = function (sql) {
        if (!paused && sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          paused = true;
          original.call(this, 'BEGIN EXCLUSIVE');
          process.stdout.write('locked\\n');
          readSync(0, Buffer.alloc(1), 0, 1, null);
          original.call(this, 'ROLLBACK');
        }
        return original.call(this, sql);
      };
      const { LocalStateStore } = await import(${JSON.stringify(COMPILED)});
      try {
        const store = LocalStateStore.open(${JSON.stringify(directory)}, ${JSON.stringify(MIGRATIONS)});
        const identity = store.identity();store.close();
        process.stdout.write(JSON.stringify({ok:true,identity})+'\\n');
      } catch(error) {
        process.stdout.write(JSON.stringify({ok:false,message:error?.message,stack:error?.stack,cause:error?.cause?.message})+'\\n');
        process.exitCode=1;
      }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    const locked = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('locked\n')) resolve();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', () => {
        if (!output.includes('locked\n'))
          reject(new Error(`Initializer did not reach its barrier: ${output} ${stderr}`));
      });
    });
    const done = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      await locked;
      const peers = await coordinatedOpen(directory, 5);
      child.stdin.end('continue');
      const code = await done;
      const reply = JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as {
        ok: boolean;
        identity: unknown;
      };
      expect({ code, reply, stderr }).toMatchObject({ code: 0, reply: { ok: true } });
      const results = peers.map((peer) => ({
        code: peer.code,
        reply: JSON.parse(peer.output.trim().split('\n').at(-1) ?? '{}') as {
          ok: boolean;
          identity: unknown;
        },
      }));
      expect(results).toEqual(
        Array.from({ length: 5 }, () => ({
          code: 0,
          reply: expect.objectContaining({ ok: true, identity: reply.identity }),
        })),
      );
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    }
  });
});

describe('initial state publication', () => {
  it('removes the private name while a competing canonical reader remains open', async () => {
    await withTempProject({}, async (project) => {
      const lore = project.path('.lore');
      const canonical = project.path('.lore/state.sqlite');
      const held: ReturnType<typeof openReadOnly>[] = [];
      const link = fs.linkSync;
      const publication = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
        link(source, target);
        if (target === canonical) held.push(openReadOnly(canonical));
      });
      syncBuiltinESMExports();
      try {
        const store = LocalStateStore.open(lore, MIGRATIONS);
        const identity = store.identity();
        store.close();
        expect(held).toHaveLength(1);
        expect(
          held[0]
            ?.prepare(
              'SELECT corpus_id AS corpusId, namespace_id AS namespaceId FROM runtime_identity',
            )
            .get(),
        ).toEqual(identity);
        expect(statSync(canonical).nlink).toBe(1);
        expect(readdirSync(project.path('.lore/tmp'))).toEqual([]);
      } finally {
        publication.mockRestore();
        syncBuiltinESMExports();
        for (const db of held) db.close();
      }
    });
  });

  it.each([
    {
      name: 'failed migration',
      sql: 'CREATE TABLE incomplete (value TEXT); SELECT missing_function();',
      code: 'LORE_E_INTERNAL',
    },
    {
      name: 'missing runtime identity',
      sql: 'CREATE TABLE incomplete (value TEXT);',
      code: 'LORE_E_SCHEMA_MISMATCH',
    },
  ])('never publishes state after $name and cleans its own candidate', async ({ sql, code }) => {
    await withTempProject(
      {
        files: {
          'migrations/0001_incomplete.sql': sql,
          '.lore/keep.txt': 'existing project bytes',
        },
      },
      async (project) => {
        expect(() =>
          LocalStateStore.open(project.path('.lore'), project.path('migrations')),
        ).toThrowError(expect.objectContaining({ code }));
        expect(existsSync(project.path('.lore/state.sqlite'))).toBe(false);
        expect(readdirSync(project.path('.lore/tmp'))).toEqual([]);
        expect(readFileSync(project.path('.lore/keep.txt'), 'utf8')).toBe('existing project bytes');
      },
    );
  });
});
