import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory: string;
let databasePath: string;
let handleMessage: (message: unknown) => void;
const messages: unknown[] = [];
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  vi.resetModules();
  messages.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'lorepack-query-child-'));
  databasePath = join(directory, 'context.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE public_values (value TEXT);
    INSERT INTO public_values VALUES ('one'), ('two'), ('three');
    CREATE TABLE private_values (value TEXT);
    INSERT INTO private_values VALUES ('secret');
  `);
  db.close();

  const sqlite = await import('../src/sqlite.js');
  const openReadOnly = sqlite.openReadOnly;
  vi.spyOn(sqlite, 'openReadOnly').mockImplementation((path, options) => {
    const connection = openReadOnly(path, options);
    opened.push(connection);
    return connection;
  });
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'message') {
      handleMessage = listener;
      return process;
    }
    return on(event, listener);
  });
  vi.spyOn(process, 'send').mockImplementation((message) => {
    messages.push(message);
    return true;
  });
  await import('../src/sql/query-child.js');
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function configure(): void {
  handleMessage({ databasePath, allowedTables: ['public_values'] });
  expect(messages.pop()).toEqual({ ready: true });
  expect(opened).toHaveLength(1);
}

function query(sql: string, limit = 10, maxBytes = 1024): unknown {
  handleMessage({ sql, limit, maxBytes });
  expect(messages).toHaveLength(1);
  return messages.pop();
}

describe('SQL child message boundary against real SQLite', () => {
  it('refuses startup without an IPC channel', async () => {
    vi.mocked(process.send).mockRestore();
    const send = process.send;
    process.send = undefined;
    try {
      vi.resetModules();
      await expect(import('../src/sql/query-child.js')).rejects.toThrow(
        'The query engine must be started with an IPC channel.',
      );
    } finally {
      process.send = send;
    }
  });

  it('redacts an unavailable catalog path', () => {
    handleMessage({ databasePath: join(directory, 'missing.sqlite'), allowedTables: [] });
    expect(messages).toEqual([{ ok: false, kind: 'unavailable' }]);
    expect(JSON.stringify(messages)).not.toContain(directory);
  });

  it('refuses a query before setup', () => {
    expect(query('SELECT 1')).toEqual({
      ok: false,
      kind: 'failed',
      message: 'The query engine was not configured.',
    });
  });

  it('returns one extra row only as a truncation signal', () => {
    configure();
    expect(query('SELECT value FROM public_values ORDER BY value', 1)).toEqual({
      ok: true,
      columns: ['value'],
      rows: [{ value: 'one' }],
      truncated: true,
    });
  });

  it('keeps column names when a filter returns no rows', () => {
    configure();
    expect(query("SELECT value AS label FROM public_values WHERE value = 'absent'")).toEqual({
      ok: true,
      columns: ['label'],
      rows: [],
      truncated: false,
    });
  });

  it('stops at the first row exceeding the serialized byte limit', () => {
    configure();
    const bytes = Buffer.byteLength(JSON.stringify([{ value: 'one' }]));
    expect(query("SELECT value FROM public_values WHERE value = 'one'", 10, bytes)).toMatchObject({
      ok: true,
      rows: [{ value: 'one' }],
    });
    expect(query("SELECT value FROM public_values WHERE value = 'one'", 10, bytes - 1)).toEqual({
      ok: false,
      kind: 'too-large',
      bytes,
      peakRssBytes: expect.any(Number),
    });
  });

  it.each([
    'SELECT value FROM private_values',
    "UPDATE public_values SET value = 'changed'",
    'DROP TABLE public_values',
    "SELECT load_extension('untrusted')",
    'SELECT random()',
  ])('denies %s without the parent statement guard', (sql) => {
    configure();
    expect(query(sql)).toMatchObject({ ok: false, kind: 'failed', message: expect.any(String) });
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare('SELECT value FROM public_values ORDER BY value').all()).toEqual([
        { value: 'one' },
        { value: 'three' },
        { value: 'two' },
      ]);
    } finally {
      db.close();
    }
  });

  it('allows bounded recursion and approved functions over allowed values', () => {
    configure();
    expect(
      query(
        'WITH n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 3) SELECT sum(v) AS v FROM n',
      ),
    ).toEqual({ ok: true, columns: ['v'], rows: [{ v: 6 }], truncated: false });
  });

  it('allows a JSON row source without granting reads of private tables', () => {
    configure();
    expect(query("SELECT value FROM json_each('[1,2]') ORDER BY value")).toEqual({
      ok: true,
      columns: ['value'],
      rows: [{ value: 1 }, { value: 2 }],
      truncated: false,
    });
    expect(query('SELECT value FROM private_values')).toMatchObject({ ok: false, kind: 'failed' });
  });
});
