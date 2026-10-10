import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoreError } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { verifyArchive, writeArchive } from '../src/archive.js';
import { createCandidateDirectory, sweepCandidateDirectories } from '../src/atomic.js';
import { writeCatalog } from '../src/catalog/writer.js';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { FileObjectStore } from '../src/object-store.js';
import { inTransaction, openWritable, storageFailure } from '../src/sqlite.js';

/**
 * Crash and disk-full behaviour of local storage writes (#572). Each case is a failure a
 * real machine produces: a process killed mid-write, a full disk, a build killed before it
 * sealed. None may damage what already exists, and each must say what actually happened.
 */

const PACKAGE = join(import.meta.dirname, '..');
const MIGRATIONS = join(PACKAGE, 'migrations');
const COMPILED_ARCHIVE = pathToFileURL(join(PACKAGE, 'dist', 'archive.js')).href;

/** Caps the database at its current size, so the next page it needs fails as SQLITE_FULL. */
function fillDisk(db: ReturnType<typeof openWritable>): void {
  const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
  db.exec(`PRAGMA max_page_count = ${page_count}`);
}

function bigArtifact(index: number) {
  const id = `src:doc-${index}.md`;
  const text = randomBytes(4096).toString('hex');
  return {
    artifact: {
      id,
      sourceId: 'src',
      relativePath: `doc-${index}.md`,
      displayPath: `doc-${index}.md`,
      mediaType: 'text/markdown',
      byteSize: text.length,
      contentHash: 'a'.repeat(64),
      parserId: 'markdown',
      parserVersion: '0.1.0',
      title: `Doc ${index}`,
      status: 'active' as const,
      authority: 50,
      supersedes: [],
      metadata: {},
    },
    nodes: [],
    objectHash: 'c'.repeat(64),
    chunks: [
      {
        id: `${id}@0`,
        artifactId: id,
        nodeIds: [],
        headingPath: [],
        text,
        estimatedTokens: 10,
        locator: { relativePath: `doc-${index}.md`, lineStart: 1, lineEnd: 1 },
        revisionHash: 'd'.repeat(64),
      },
    ],
  };
}

describe('a full disk', () => {
  it('is reported as LORE_E_DISK_FULL by the catalog writer, not as a failed rollback', async () => {
    await withTempProject({}, (project) => {
      const db = openWritable(project.path('context.sqlite'));
      try {
        runMigrations(db, loadMigrations(join(MIGRATIONS, 'build')));
        fillDisk(db);
        const artifacts = Array.from({ length: 50 }, (_, index) => bigArtifact(index));
        let failure: unknown;
        try {
          writeCatalog({ db, artifacts });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(LoreError);
        expect(failure).toMatchObject({
          code: 'LORE_E_DISK_FULL',
          remediation: expect.stringMatching(/free/i),
        });
        expect((failure as LoreError).message).not.toMatch(/rollback/i);
        expect(db.isTransaction).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it('is reported as LORE_E_DISK_FULL by a migration', async () => {
    await withTempProject({}, (project) => {
      const db = openWritable(project.path('context.sqlite'));
      try {
        db.exec('CREATE TABLE filler (x)');
        fillDisk(db);
        expect(() => runMigrations(db, loadMigrations(join(MIGRATIONS, 'build')))).toThrow(
          expect.objectContaining({ code: 'LORE_E_DISK_FULL' }),
        );
        expect(db.isTransaction).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it('surfaces the original error when SQLite has already ended the transaction', async () => {
    await withTempProject({}, (project) => {
      const db = openWritable(project.path('state.sqlite'));
      try {
        db.exec('CREATE TABLE t (x)');
        // What SQLite does on SQLITE_FULL and some I/O errors: the transaction is gone by the
        // time the caller's error handler runs.
        const original = new Error('the real failure');
        expect(() =>
          inTransaction(db, () => {
            db.exec('INSERT INTO t VALUES (1)');
            db.exec('ROLLBACK');
            throw original;
          }),
        ).toThrow(original);
        expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });
  });

  it('maps ENOSPC from a file write to LORE_E_DISK_FULL', () => {
    const cause = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    expect(storageFailure(cause)).toMatchObject({ code: 'LORE_E_DISK_FULL', cause });
    const other = new Error('something else');
    expect(storageFailure(other)).toBe(other);
  });
});

describe('writing an archive', () => {
  it('replaces an existing archive only when the new one is complete', async () => {
    await withTempProject({}, async (project) => {
      const destination = project.path('out/project.lorepack');
      mkdirSync(dirname(destination), { recursive: true });
      await writeArchive(destination, [
        { path: 'manifest.json', bytes: new TextEncoder().encode('{"good":true}') },
      ]);
      expect((await verifyArchive(destination)).ok).toBe(true);

      // A second pack to the same path, killed while it is writing.
      const writer = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { writeArchive } = await import(${JSON.stringify(COMPILED_ARCHIVE)});
           const { randomBytes } = await import('node:crypto');
           const members = [{ path: 'manifest.json', bytes: new TextEncoder().encode('{}') }];
           for (let i = 0; i < 400; i += 1) members.push({ path: 'objects/' + i, bytes: randomBytes(256 * 1024) });
           process.stdout.write('writing\\n');
           await writeArchive(${JSON.stringify(destination)}, members);`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      const exited = new Promise((resolve) => writer.once('exit', resolve));
      let finished = false;
      void exited.then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => writer.stdout.once('data', () => resolve()));
      const goodSize = statSync(destination).size;
      // Killed as soon as the write has visibly begun: a temporary file beside the archive,
      // or the archive itself changing size when it is written in place.
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          const begun =
            readdirSync(dirname(destination)).length > 1 || statSync(destination).size !== goodSize;
          if (begun || finished) {
            clearInterval(poll);
            resolve();
          }
        }, 1);
      });
      writer.kill('SIGKILL');
      await exited;

      const result = await verifyArchive(destination);
      expect(result.ok).toBe(true);
    });
  }, 60_000);
});

describe('candidates from killed builds', () => {
  it('are swept, and nothing else in tmp is touched', async () => {
    await withTempProject({}, (project) => {
      const lore = project.path('.lore');
      const first = createCandidateDirectory(lore);
      const second = createCandidateDirectory(lore);
      writeFileSync(join(first.path, 'context.sqlite'), 'partial');
      writeFileSync(join(lore, 'tmp', 'unrelated'), 'kept');

      expect(sweepCandidateDirectories(lore)).toBe(2);
      expect(existsSync(first.path)).toBe(false);
      expect(existsSync(second.path)).toBe(false);
      expect(readdirSync(join(lore, 'tmp'))).toEqual(['unrelated']);
    });
  });

  it('is a no-op for a project that has never built', async () => {
    await withTempProject({}, (project) => {
      expect(sweepCandidateDirectories(project.path('.lore'))).toBe(0);
    });
  });
});

describe('object fan-out directories', () => {
  it('are made durable in their parents when they are created', async () => {
    await withTempProject({}, async (project) => {
      const root = project.path('.lore/objects');
      const synced: string[] = [];
      const store = new FileObjectStore(root, { fsyncDirectory: (path) => synced.push(path) });
      const hash = await store.put(new TextEncoder().encode('hello'));
      const leaf = join(root, 'sha256', hash.slice(0, 2), hash.slice(2, 4));
      // Every directory that came into existence is recorded in its parent, up to the root.
      expect(synced).toEqual(
        expect.arrayContaining([dirname(leaf), join(root, 'sha256'), root, dirname(root)]),
      );

      synced.length = 0;
      await store.put(new TextEncoder().encode('hello'));
      expect(synced).toEqual([]);
    });
  });
});
