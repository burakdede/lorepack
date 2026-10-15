import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validBuild } from './archive_fixture.js';

let directory: string;
let originalArgv: string[];
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), 'lorepack-archive-child-'));
  originalArgv = process.argv;
  for (const [name, bytes] of validBuild(directory)) {
    writeFileSync(join(directory, name.replace('reports/', '')), bytes);
  }
  process.argv = [
    process.execPath,
    'archive-verify-child.js',
    join(directory, 'context.sqlite'),
    join(directory, 'manifest.json'),
    join(directory, 'build-id-inputs.json'),
  ];
  const sqlite = await import('../src/sqlite.js');
  const open = sqlite.openReadOnly;
  vi.spyOn(sqlite, 'openReadOnly').mockImplementation((path, options) => {
    const db = open(path, options);
    opened.push(db);
    return db;
  });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) {
    expect(() => db.prepare('SELECT 1')).toThrow('database is not open');
  }
  rmSync(directory, { recursive: true, force: true });
});

async function run(): Promise<Record<string, unknown>> {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await import('../src/archive-verify-child.js');
  } finally {
    write.mockRestore();
  }
  return JSON.parse(output);
}
function replace(name: string, change: (value: Record<string, unknown>) => void): void {
  const path = join(directory, name);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, JSON.stringify(value));
}
const GENERIC = {
  ok: false,
  code: 'LORE_E_OBJECT_CORRUPT',
  subject: 'context.sqlite',
  message: 'The package contains invalid catalog or identity data.',
};

describe('archive verifier JSON boundary against real SQLite', () => {
  it('returns a logical proof for a valid catalog and closes its connection', async () => {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    expect(await run()).toEqual({
      ok: true,
      proof: {
        buildId: manifest.buildId,
        objectHashes: [],
        canonicalRoots: manifest.canonicalRoots,
      },
    });
    expect(opened).toHaveLength(1);
  });
  it.each([0, 1, 2])('refuses a missing argument at position %s', async (count) => {
    process.argv = process.argv.slice(0, count + 2);
    expect(await run()).toEqual(GENERIC);
    expect(opened).toHaveLength(0);
  });
  it.each(['manifest.json', 'build-id-inputs.json'])(
    'redacts malformed JSON in %s',
    async (name) => {
      writeFileSync(join(directory, name), 'private source text {');
      expect(await run()).toEqual(GENERIC);
      expect(opened).toHaveLength(0);
    },
  );
  it.each(['manifest.json', 'build-id-inputs.json'])(
    'refuses invalid schema in %s',
    async (name) => {
      writeFileSync(join(directory, name), '{}');
      expect(await run()).toEqual(GENERIC);
      expect(opened).toHaveLength(0);
    },
  );
  it('redacts a malformed catalog', async () => {
    writeFileSync(join(directory, 'context.sqlite'), 'private database content');
    expect(await run()).toEqual(GENERIC);
    expect(opened).toHaveLength(1);
  });
  it('preserves the typed unsupported-version error and closes the catalog', async () => {
    replace('build-id-inputs.json', (value) => {
      value.canonicalizationVersion = 999;
    });
    expect(await run()).toEqual({
      ok: false,
      code: 'LORE_E_SCHEMA_MISMATCH',
      subject: 'reports/build-id-inputs.json',
      message: 'The package uses an unsupported catalog or hashing version.',
    });
    expect(opened).toHaveLength(1);
  });
});
