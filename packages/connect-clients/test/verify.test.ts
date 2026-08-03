import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * `lore mcp` as a client would.
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
