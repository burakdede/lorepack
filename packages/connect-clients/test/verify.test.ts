import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyStdioServer } from '../src/verify.js';

/**
 * Verifying the thing we just configured, against the real binary.
 *
 * Architecture 6.6 step 9 makes this part of connecting rather than an afterthought, because
 * every failure here is otherwise silent: a config file written correctly, naming a command
 * that is not on the path, looks exactly like success until someone asks their agent a
 * question and gets nothing back.
 *
 * A fixture server would only prove the verifier agrees with itself. These drive
 * `lorepack mcp` as a client would.
 */

const BINARY = join(import.meta.dirname, '..', '..', 'cli', 'dist', 'entry.js');
const CONFIG = 'version: 1\nname: connected\nsources:\n  - .\n';

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'lore-verify-'));
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'lore.yaml'), CONFIG, 'utf8');
  writeFileSync(
    join(project, 'docs', 'a.md'),
    '# A\n\nRollback restores the previous build.\n',
    'utf8',
  );
});

afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows holds the build database a moment after the child exits; a leaked temp
    // directory must never fail a run that already passed its assertions.
  }
});

describe('a server that works', () => {
  it('confirms the protocol revision and the tool surface', async () => {
    const check = await verifyStdioServer({
      executable: process.execPath,
      args: [BINARY, '--cwd', project, 'mcp', '--ensure-current'],
    });

    expect(check.ok, check.detail).toBe(true);
    expect(check.step).toBe('none');
    // The assertion that matters: `tools/list` alone would pass against a 2025-era server,
    // because it ignores an unrecognized `_meta` and answers normally. Only `server/discover`
    // settles which revision is actually being spoken.
    expect(check.protocolVersion).toBe('2026-07-28');
    expect(check.detail).toContain('tools');
  }, 120_000);
});

describe('a server that is not there', () => {
  it('says the command could not be started, and names it', async () => {
    const check = await verifyStdioServer({
      executable: 'lorepack-command-that-does-not-exist',
      args: [],
      timeoutMs: 20_000,
    });

    expect(check.ok).toBe(false);
    expect(check.step).toBe('spawn');
    // Actionable: a generic "verification failed" sends a user looking at their client, and
    // the problem is a command in the file we wrote.
    expect(check.detail).toContain('lorepack-command-that-does-not-exist');
    expect(check.detail).toContain('on the path');
  }, 120_000);
});

describe('a command that starts and is not a server', () => {
  it('fails rather than reporting a working connection', async () => {
    // A real hazard: a path that resolves to something harmless produces a process that
    // starts fine and never speaks the protocol. Without a bound this hangs a connect.
    const check = await verifyStdioServer({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 3000,
    });

    expect(check.ok).toBe(false);
    expect(['spawn', 'tools']).toContain(check.step);
  }, 120_000);
});

/** Whether a process is still running. Signal 0 checks without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('a server that never answers (#578)', () => {
  it('is stopped when verification gives up, along with any probe it started', async () => {
    // Each process the verifier starts records its pid and then hangs, which is what a real
    // `lorepack mcp --ensure-current` stuck behind a long build looks like from outside.
    const pids = join(project, 'pids');
    mkdirSync(pids);
    const hang = `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(
      pids,
    )}, String(process.pid)), ''); setInterval(() => {}, 1000);`;

    const check = await verifyStdioServer({
      executable: process.execPath,
      args: ['-e', hang],
      timeoutMs: 2000,
    });

    expect(check.ok).toBe(false);
    expect(check.step).toBe('spawn');
    expect(check.detail).toContain('timed out');

    const started = readdirSync(pids).map(Number);
    expect(started.length).toBeGreaterThan(0);
    expect(started.filter(alive)).toEqual([]);
  }, 120_000);
});
