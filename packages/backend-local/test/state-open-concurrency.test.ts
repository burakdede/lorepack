import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWritable } from '../src/sqlite.js';
import { LocalStateStore } from '../src/state-store.js';

/**
 * Opening `state.sqlite` while another process is using it (#571).
 *
 * The dev loop, MCP sessions and Studio open state concurrently by design. Opening for writing
 * set the journal mode before the busy timeout, so a writer holding the database for a moment
 * failed the open outright with `LORE_E_SQLITE_UNAVAILABLE`. And the first open of a new
 * project decided which migrations to apply before taking the write lock, so two first opens
 * could both apply `0001` and one failed with `table builds already exists`.
 */

const PACKAGE = join(import.meta.dirname, '..');
const STATE_MIGRATIONS = join(PACKAGE, 'migrations', 'state');
const COMPILED = pathToFileURL(join(PACKAGE, 'dist', 'index.js')).href;

const OPENERS = 6;
const TRIALS = 10;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lorepack-state-open-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function holdExclusive(path: string, holdMs: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec('BEGIN EXCLUSIVE');
       db.exec('INSERT INTO builds_probe VALUES (1)');
       process.stdout.write('locked\\n');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((resolve, reject) => {
    child.stdout?.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`lock holder exited with ${code}`)));
  });
}

function openInChildren(loreDirectory: string, count: number): Promise<string[]> {
  const script = `
    const { LocalStateStore } = await import(${JSON.stringify(COMPILED)});
    try {
      LocalStateStore.open(${JSON.stringify(loreDirectory)}, ${JSON.stringify(STATE_MIGRATIONS)}).close();
      process.stdout.write('ok');
    } catch (error) {
      process.stdout.write(String(error?.message ?? error) + ' ' + String(error?.cause?.message ?? ''));
    }`;
  return Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            stdio: ['ignore', 'pipe', 'inherit'],
          });
          let output = '';
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
          });
          child.once('exit', () => resolve(output.trim()));
        }),
    ),
  );
}

describe('opening state while another process uses it', () => {
  it('opens for writing while another process holds the write lock, by waiting', async () => {
    const path = join(scratch, 'writable.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE builds_probe (n INTEGER)');
    setup.close();

    const holder = await holdExclusive(path, 1_000);
    try {
      const started = Date.now();
      const db = openWritable(path);
      expect(db.prepare('SELECT count(*) AS n FROM builds_probe').get()).toEqual({ n: 1 });
      db.close();
      expect(Date.now() - started).toBeGreaterThan(300);
    } finally {
      holder.kill();
    }
  });

  it('opens the state store while another process holds the write lock', async () => {
    const lore = join(scratch, 'busy', '.lore');
    LocalStateStore.open(lore, STATE_MIGRATIONS).close();
    const path = join(lore, 'state.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE builds_probe (n INTEGER)');
    setup.close();

    const holder = await holdExclusive(path, 1_500);
    try {
      const started = Date.now();
      const store = LocalStateStore.open(lore, STATE_MIGRATIONS);
      expect(store.listBuilds()).toEqual([]);
      store.close();
      expect(Date.now() - started).toBeGreaterThan(500);
    } finally {
      holder.kill();
    }
  });

  it(`applies migrations once when ${OPENERS} processes open a new project together`, async () => {
    const failures: string[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const lore = join(scratch, `cold-${trial}`, '.lore');
      mkdirSync(lore, { recursive: true });
      const results = await openInChildren(lore, OPENERS);
      failures.push(...results.filter((result) => result !== 'ok'));
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('records each migration exactly once after a concurrent first open', async () => {
    const lore = join(scratch, 'once', '.lore');
    mkdirSync(lore, { recursive: true });
    writeFileSync(join(lore, '.keep'), '');
    expect(await openInChildren(lore, OPENERS)).toEqual(Array(OPENERS).fill('ok'));
    const db = new DatabaseSync(join(lore, 'state.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT id FROM schema_migrations').all();
      expect(rows).toEqual([{ id: '0001' }, { id: '0002' }]);
      expect(db.prepare('SELECT count(*) AS n FROM runtime_identity').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
