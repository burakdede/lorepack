import { readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LoreError } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { assertFts5Available, type Fts5ProbeResult, probeFts5 } from '../src/fts5.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import {
  assertSqliteApiSurface,
  integrityCheck,
  openReadOnly,
  openWritable,
  restrictToTables,
  SAFE_QUERY_LIMITS,
  sqliteVersion,
} from '../src/sqlite.js';

describe('node:sqlite API surface', () => {
  it('has every member this adapter depends on', () => {
    const db = new DatabaseSync(':memory:');
    try {
      expect(() => assertSqliteApiSurface(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('fails with a typed error naming what is missing', () => {
    const crippled = { limits: {}, setAuthorizer: undefined } as unknown as DatabaseSync;
    try {
      assertSqliteApiSurface(crippled);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_SQLITE_UNAVAILABLE');
      expect((error as LoreError).message).toContain('setAuthorizer');
      expect((error as LoreError).message).toContain('enableDefensive');
      expect((error as LoreError).remediation).toContain('nodejs.org');
    }
  });
});

describe('FTS5 probe', () => {
  it('reports availability with the versions that explain a failure', () => {
    const result = probeFts5();
    expect(result.available).toBe(true);
    expect(result.sqliteVersion).toMatch(/^\d+\.\d+/);
    expect(result.nodeVersion).toBe(process.versions.node);
    expect(result.execPath).toBe(process.execPath);
  });

  it('leaves no probe table behind', () => {
    probeFts5();
    const db = new DatabaseSync(':memory:');
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'probe'")
      .all() as unknown[];
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('fails closed with an actionable message when FTS5 is absent', () => {
    const absent: Fts5ProbeResult = {
      available: false,
      sqliteVersion: '3.44.0',
      nodeVersion: '24.15.0',
      execPath: '/usr/bin/node',
      detail: 'no such module: fts5',
    };
    try {
      assertFts5Available(absent);
      expect.unreachable('should have thrown');
    } catch (error) {
      const loreError = error as LoreError;
      expect(loreError.code).toBe('LORE_E_FTS5_UNAVAILABLE');
      expect(loreError.message).toContain('3.44.0');
      expect(loreError.remediation).toContain('nodejs.org');
      expect(loreError.remediation).toContain('shared system SQLite');
      expect(loreError.details).toMatchObject({ execPath: '/usr/bin/node' });
    }
  });

  it('does not throw when FTS5 is present', () => {
    expect(() => assertFts5Available()).not.toThrow();
  });
});

describe('opening databases', () => {
  it('refuses to write through a read-only handle', async () => {
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      const writable = openWritable(path);
      writable.exec('CREATE TABLE t (a TEXT) STRICT');
      writable.close();

      const readonly = openReadOnly(path);
      expect(() => readonly.exec("INSERT INTO t VALUES ('x')")).toThrow();
      readonly.close();
    });
  });

  it('applies bounded runtime limits and verifies they took effect', async () => {
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      openWritable(path).close();
      const db = openReadOnly(path);
      const limits = (db as unknown as { limits: Record<string, number> }).limits;
      expect(limits.sqlLength).toBe(SAFE_QUERY_LIMITS.sqlLength);
      expect(limits.attach).toBe(0);
      expect(limits.compoundSelect).toBe(SAFE_QUERY_LIMITS.compoundSelect);
      db.close();
    });
  });

  it('rejects an over-long statement once the limit is applied', async () => {
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      const writable = openWritable(path);
      writable.exec('CREATE TABLE t (a TEXT) STRICT');
      writable.close();

      const db = openReadOnly(path);
      const huge = `SELECT '${'x'.repeat(SAFE_QUERY_LIMITS.sqlLength)}' AS a`;
      expect(() => db.prepare(huge)).toThrow();
      db.close();
    });
  });

  it('fails with a typed error when the database does not exist', () => {
    try {
      openReadOnly('/nonexistent/path/to/build.sqlite');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_SQLITE_UNAVAILABLE');
      // #168: this asserted `lore doctor`, a command that does not exist until Phase 3.
      expect((error as LoreError).remediation).toContain('lore builds');
    }
  });

  it('leaves a single file behind, so a read never writes and a build packs as one file', async () => {
    // A WAL database grows `-wal` and `-shm` siblings, and a read-only connection creates
    // them without being able to remove them. That would make `lore status` write to disk.
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      const writable = openWritable(path);
      writable.exec('CREATE TABLE t (a TEXT) STRICT');
      writable.exec("INSERT INTO t VALUES ('x')");
      expect(
        (writable.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      ).toBe('delete');
      writable.close();

      const readonly = openReadOnly(path);
      readonly.prepare('SELECT a FROM t').all();
      readonly.close();

      expect(readdirSync(project.root).filter((name) => name.startsWith('build.sqlite'))).toEqual([
        'build.sqlite',
      ]);
    });
  });

  it('reports the SQLite version', async () => {
    await withTempProject({}, (project) => {
      const db = openWritable(project.path('b.sqlite'));
      expect(sqliteVersion(db)).toMatch(/^\d+\.\d+\.\d+$/);
      db.close();
    });
  });
});

describe('authorizer', () => {
  async function withRestricted(run: (db: DatabaseSync) => void): Promise<void> {
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      const writable = openWritable(path);
      writable.exec('CREATE TABLE allowed (a TEXT) STRICT');
      writable.exec('CREATE TABLE secret (b TEXT) STRICT');
      writable.exec("INSERT INTO allowed VALUES ('visible')");
      writable.exec("INSERT INTO secret VALUES ('hidden')");
      writable.close();

      const db = openReadOnly(path);
      restrictToTables(db, ['allowed']);
      try {
        run(db);
      } finally {
        db.close();
      }
    });
  }

  it('permits reads from an allowlisted table', async () => {
    await withRestricted((db) => {
      expect(db.prepare('SELECT a FROM allowed').get()).toMatchObject({ a: 'visible' });
    });
  });

  it('denies reads from a table outside the allowlist', async () => {
    await withRestricted((db) => {
      expect(() => db.prepare('SELECT b FROM secret').get()).toThrow();
    });
  });

  it('denies schema inspection through sqlite_master', async () => {
    await withRestricted((db) => {
      expect(() => db.prepare('SELECT name FROM sqlite_master').all()).toThrow();
    });
  });

  it.each([
    ['DDL', 'CREATE TABLE evil (a TEXT)'],
    ['DML', "INSERT INTO allowed VALUES ('x')"],
    ['ATTACH', "ATTACH DATABASE 'other.sqlite' AS other"],
    ['PRAGMA', 'PRAGMA journal_mode'],
  ])('denies %s at the engine boundary', async (_kind, sql) => {
    await withRestricted((db) => {
      expect(() => db.exec(sql)).toThrow();
    });
  });

  it('permits data_version alone, which FTS5 reads internally', async () => {
    // Denying it makes MATCH fail outright. It exposes a change counter and nothing else,
    // and the surrounding cases prove every other pragma is still refused.
    await withRestricted((db) => {
      expect(() => db.prepare('PRAGMA data_version').get()).not.toThrow();
      expect(() => db.prepare('PRAGMA database_list').all()).toThrow();
    });
  });
});

describe('integrity check', () => {
  it('passes on a healthy database', async () => {
    await withTempProject({}, (project) => {
      const path = project.path('build.sqlite');
      const db = openWritable(path);
      db.exec('CREATE TABLE t (a TEXT) STRICT');
      const result = integrityCheck(db);
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
      db.close();
    });
  });
});

describe('migrations', () => {
  const first = 'CREATE TABLE artifacts (id TEXT PRIMARY KEY, path TEXT NOT NULL) STRICT;\n';
  const second = 'CREATE TABLE chunks (id TEXT PRIMARY KEY) STRICT;\n';

  async function withMigrations(
    files: Record<string, string>,
    run: (dir: string, db: DatabaseSync) => void,
  ): Promise<void> {
    await withTempProject({ files }, (project) => {
      const db = openWritable(project.path('db.sqlite'));
      try {
        run(project.path('migrations'), db);
      } finally {
        db.close();
      }
    });
  }

  it('applies migrations in order and records them', async () => {
    await withMigrations(
      { 'migrations/0001_catalog.sql': first, 'migrations/0002_chunks.sql': second },
      (dir, db) => {
        const result = runMigrations(db, loadMigrations(dir));
        expect(result.applied).toEqual(['0001', '0002']);
        const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all();
        expect(rows).toHaveLength(2);
      },
    );
  });

  it('is idempotent on a second run', async () => {
    await withMigrations({ 'migrations/0001_catalog.sql': first }, (dir, db) => {
      const migrations = loadMigrations(dir);
      runMigrations(db, migrations);
      const second_ = runMigrations(db, migrations);
      expect(second_.applied).toEqual([]);
      expect(second_.alreadyApplied).toEqual(['0001']);
    });
  });

  it('refuses an applied migration whose contents changed', async () => {
    await withTempProject({ files: { 'migrations/0001_catalog.sql': first } }, (project) => {
      const db = openWritable(project.path('db.sqlite'));
      runMigrations(db, loadMigrations(project.path('migrations')));
      writeFileSync(
        project.path('migrations/0001_catalog.sql'),
        `${first}-- an edit after the fact\n`,
        'utf8',
      );
      try {
        runMigrations(db, loadMigrations(project.path('migrations')));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).message).toContain('changed after it was applied');
        expect((error as LoreError).remediation).toContain('Never edit an applied migration');
      } finally {
        db.close();
      }
    });
  });

  it('rolls back a failing migration and leaves the database unchanged', async () => {
    await withMigrations(
      {
        'migrations/0001_catalog.sql': first,
        'migrations/0002_broken.sql': 'CREATE TABLE chunks (id TEXT); SELECT this_is_not_valid(;',
      },
      (dir, db) => {
        expect(() => runMigrations(db, loadMigrations(dir))).toThrowError(LoreError);
        const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
          id: string;
        }>;
        expect(applied.map((row) => row.id)).toEqual(['0001']);
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
          .all();
        expect(tables).toHaveLength(0);
      },
    );
  });

  it('rejects a malformed migration file name', async () => {
    await withMigrations({ 'migrations/first.sql': first }, (dir) => {
      expect(() => loadMigrations(dir)).toThrowError(/name is malformed/);
    });
  });

  it('rejects duplicate migration numbers', async () => {
    await withMigrations(
      { 'migrations/0001_a.sql': first, 'migrations/0001_b.sql': second },
      (dir) => {
        expect(() => loadMigrations(dir)).toThrowError(/Duplicate migration number/);
      },
    );
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(loadMigrations('/nonexistent/migrations')).toEqual([]);
  });
});
