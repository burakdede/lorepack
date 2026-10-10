import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `LORE_DEV_PORT` and `LORE_REVALIDATE_INTERVAL_MS` change what actually runs (#582).
 *
 * `lorepack config explain` reported both as the effective values while `dev`, `serve` and
 * `mcp` read only their flags, so the report and the process disagreed. Each case here starts
 * the built binary with the variable set and observes the running server: the port it answers
 * on, and whether an edit shows up in `/health` before or after the interval. A flag beside
 * the variable has to win.
 */

const ENTRY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');
/** Clear of the dev suite's 4700 range, the security suite's 47610, and both defaults. */
const BASE_PORT = 47_820;
const HOUR = '3600000';

let project: string;
const running: ChildProcess[] = [];

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-serving-env-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'lore.yaml'), 'version: 1\nname: env\nsources:\n  - .\n');
  writeFileSync(join(project, 'docs', 'a.md'), '# A\n\nRollback restores the previous build.\n');
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const give = setTimeout(resolve, 10_000);
      child.once('exit', () => {
        clearTimeout(give);
        resolve(undefined);
      });
    });
  }
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Starts a long-running command and waits until it prints a line containing `ready`. */
async function start(
  args: readonly string[],
  env: Record<string, string>,
  ready: string,
): Promise<string> {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  running.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const deadline = Date.now() + 90_000;
  while (!output.includes(ready) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(output, `never printed ${ready}:\n${output}`).toContain(ready);
  return output;
}

function run(
  args: readonly string[],
  env: Record<string, string>,
): { code: number; output: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: project,
    encoding: 'utf8',
    input: '',
    timeout: 90_000,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

async function sourceState(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return ((await response.json()) as { sourceState: string }).sourceState;
}

/** Edits a source after the server's first freshness check, then asks again. */
async function stateAfterEdit(port: number): Promise<string> {
  expect(await sourceState(port)).toBe('clean');
  writeFileSync(join(project, 'docs', 'a.md'), '# A\n\nRollback restores an older build.\n');
  return sourceState(port);
}

describe('LORE_DEV_PORT (#582)', () => {
  it('is the port lorepack dev listens on', async () => {
    const port = BASE_PORT;
    const output = await start(['dev'], { LORE_DEV_PORT: String(port) }, 'MCP stdio');

    expect(output).toContain(`127.0.0.1:${port}`);
    expect(await sourceState(port)).toBeTruthy();
  });

  it('loses to --port', async () => {
    const port = BASE_PORT + 2;
    const output = await start(
      ['dev', '--port', String(port)],
      { LORE_DEV_PORT: String(BASE_PORT + 4) },
      'MCP stdio',
    );

    expect(output).toContain(`127.0.0.1:${port}`);
    expect(output).not.toContain(`127.0.0.1:${BASE_PORT + 4}`);
  });

  it('is refused, naming the variable, when it is not a port', () => {
    const { code, output } = run(['dev'], { LORE_DEV_PORT: 'eighty' });

    expect(code).toBe(1);
    expect(output).toContain('LORE_E_INVALID_ARGUMENT');
    expect(output).toContain('LORE_DEV_PORT must be a port number');
  });
});

describe('LORE_REVALIDATE_INTERVAL_MS (#582)', () => {
  beforeEach(() => {
    expect(run(['build'], {}).code).toBe(0);
  });

  it('sets how soon lorepack serve notices an edit', async () => {
    const port = BASE_PORT + 6;
    await start(
      ['serve', '--port', String(port)],
      { LORE_REVALIDATE_INTERVAL_MS: '0' },
      'Press Ctrl-C',
    );

    expect(await stateAfterEdit(port)).toBe('dirty');
  });

  it('holds the cached answer for the whole interval it names', async () => {
    const port = BASE_PORT + 8;
    await start(
      ['serve', '--port', String(port)],
      { LORE_REVALIDATE_INTERVAL_MS: HOUR },
      'Press Ctrl-C',
    );

    expect(await stateAfterEdit(port)).toBe('clean');
  });

  it('loses to --revalidate-interval', async () => {
    const port = BASE_PORT + 10;
    await start(
      ['serve', '--port', String(port), '--revalidate-interval', HOUR],
      { LORE_REVALIDATE_INTERVAL_MS: '0' },
      'Press Ctrl-C',
    );

    expect(await stateAfterEdit(port)).toBe('clean');
  });

  it('is refused, naming the variable, by serve, mcp and config alike', () => {
    for (const args of [
      ['serve'],
      ['mcp'],
      ['config', 'explain', 'runtime.revalidateIntervalMs'],
    ]) {
      const { code, output } = run(args, { LORE_REVALIDATE_INTERVAL_MS: 'soon' });

      expect(code, `${args.join(' ')}\n${output}`).toBe(1);
      expect(output).toContain('LORE_REVALIDATE_INTERVAL_MS must be a number of milliseconds');
    }
  });
});
