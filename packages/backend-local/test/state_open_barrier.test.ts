import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const PACKAGE = join(import.meta.dirname, '..');
const COMPILED = pathToFileURL(join(PACKAGE, 'dist/index.js')).href;
const MIGRATIONS = join(PACKAGE, 'migrations/state');

async function coordinatedOpen(directory: string, count: number) {
  const script = `
    const { LocalStateStore } = await import(${JSON.stringify(COMPILED)});
    process.stdin.once('data', () => {
      const started = performance.now();
      try {
        LocalStateStore.open(${JSON.stringify(directory)}, ${JSON.stringify(MIGRATIONS)}).close();
        process.stdout.write(JSON.stringify({ ok: true, elapsedMs: performance.now() - started }) + '\\n');
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
