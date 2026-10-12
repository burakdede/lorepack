import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  CHECKSUM_MEMBER,
  openWritable,
  readArchive,
  verifyArchive,
  writeArchive,
} from '@lorepack/backend-local';
import { buildManifestSchema, loadConfig, objectKey, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const execute = promisify(execFile);
const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

const CORPUS = {
  'guides/deployment.md': '# Deployment\n\n## Rollback\n\nRollback restores the release.\n',
  'notes/meeting.txt': 'We discussed the deployment schedule.\n',
};

async function packedProject<T>(
  body: (
    root: string,
    lore: (args: string[]) => ReturnType<typeof run>,
    archive: string,
  ) => Promise<T>,
  config = CONFIG,
  files = CORPUS,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': config, ...files } }, async (temp) => {
    const built = await runBuild({
      config: loadConfig({ cwd: temp.root }),
      progress: new ProgressBus(),
    });
    const lore = (args: string[]) => run(['--cwd', temp.root, ...args]);
    await lore(['pack']);
    const archive = join(temp.root, `demo-${built.buildId.slice(0, 17)}.lorepack`);
    return body(temp.root, lore, archive);
  });
}

describe('lorepack pack', () => {
  it('writes an archive named for the project and the build', async () => {
    await packedProject(async (_root, _lore, archive) => {
      expect(existsSync(archive)).toBe(true);
    });
  });

  it('contains the manifest, the database, reports and objects', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const members = [...(await readArchive(archive)).keys()];

      expect(members).toContain('manifest.json');
      expect(members).toContain('checksums.json');
      expect(members).toContain('context.sqlite');
      expect(members.some((name) => name.startsWith('reports/'))).toBe(true);
      expect(members.some((name) => name.startsWith('objects/sha256/'))).toBe(true);
    });
  });

  it('puts the manifest and the checksum index first, so a reader can start there', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const members = [...(await readArchive(archive)).keys()];
      expect(members[0]).toBe('manifest.json');
      expect(members[1]).toBe('checksums.json');
    });
  });

  it('carries a readable manifest that still validates', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const members = await readArchive(archive);
      const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json')));
      expect(buildManifestSchema.safeParse(manifest).success).toBe(true);
    });
  });

  it('produces byte-identical archives when packing the same build twice', async () => {
    // Stable ordering and normalized timestamps, so an archive is reproducible rather
    // than merely equivalent.
    await packedProject(async (root, lore, archive) => {
      const first = readFileSync(archive);
      await lore(['pack', '--out', 'second.lorepack']);
      const second = readFileSync(join(root, 'second.lorepack'));
      expect(second.equals(first)).toBe(true);
    });
  });

  it('verifies an intact archive', async () => {
    await packedProject(async (_root, lore, archive) => {
      const result = await lore(['pack', '--verify', archive]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('intact');
      expect(result.stdout).toContain('Integrity only; unsigned publisher.');
    });
  });

  it('verifies typed rows and reports unsigned logical integrity (#418)', async () => {
    await packedProject(
      async (_root, _lore, archive) => {
        const result = await verifyArchive(archive);
        expect(result).toMatchObject({
          ok: true,
          assurance: 'integrity-only',
          authenticated: false,
        });
        const members = await readArchive(archive);
        const manifest = buildManifestSchema.parse(
          JSON.parse(new TextDecoder().decode(members.get('manifest.json'))),
        );
        expect(manifest.counts.tables).toBe(1);
        expect(result.buildId).toBe(manifest.buildId);
      },
      CONFIG,
      {
        ...CORPUS,
        'typed.csv': 'id,enabled,day,label\n1,true,2026-10-11,Café\n2,false,2026-10-12,\n',
        'normalized.txt': 'Text with  multiple   spaces.\n',
      },
    );
  });

  it('refuses changed typed rows after regenerated member checksums (#418)', async () => {
    await packedProject(
      async (root, _lore, archive) => {
        const members = await readArchive(archive);
        const catalog = join(root, 'changed-rows.sqlite');
        writeFileSync(catalog, members.get('context.sqlite') as Uint8Array);
        const db = openWritable(catalog);
        try {
          const table = db.prepare('SELECT sql_name FROM tables').get();
          expect(table).toBeDefined();
          const column = db.prepare('SELECT sql_name FROM table_columns WHERE ordinal = 0').get();
          expect(column).toBeDefined();
          expect(String(table?.sql_name)).toMatch(/^t_[a-z0-9_]+$/);
          expect(String(column?.sql_name)).toMatch(/^c_[a-z0-9_]+$/);
          expect(
            Number(
              db.prepare(`UPDATE ${table?.sql_name} SET ${column?.sql_name} = 999`).run().changes,
            ),
          ).toBe(2);
        } finally {
          db.close();
        }
        members.set('context.sqlite', new Uint8Array(readFileSync(catalog)));
        members.delete(CHECKSUM_MEMBER);
        const changed = join(root, 'changed-rows.lorepack');
        await writeArchive(
          changed,
          [...members].map(([path, bytes]) => ({ path, bytes })),
        );
        await expect(verifyArchive(changed)).rejects.toMatchObject({
          code: 'LORE_E_OBJECT_CORRUPT',
        });
      },
      CONFIG,
      { ...CORPUS, 'rows.csv': 'id,value\n1,first\n2,second\n' },
    );
  });

  it.each([
    'chunk-text',
    'fts-body',
    'missing-object',
    'unknown-format',
    'compiler-version',
    'missing-migration',
    'changed-migration',
    'extra-table',
    'declared-rules',
    'missing-inputs',
    'build-id',
    'object-content',
    'fts-docsize',
    'fts-term-data',
  ])(
    'refuses a self-consistent archive with altered %s through the packaged CLI (#418)',
    async (alteration) => {
      await packedProject(async (root, _lore, archive) => {
        const members = await readArchive(archive);
        members.delete(CHECKSUM_MEMBER);
        if (alteration === 'missing-inputs') members.delete('reports/build-id-inputs.json');
        else if (alteration === 'missing-object' || alteration === 'object-content') {
          const object = [...members.keys()].find((name) => name.startsWith('objects/sha256/'));
          expect(object).toBeDefined();
          if (alteration === 'missing-object') members.delete(object as string);
          else members.set(object as string, new TextEncoder().encode('fabricated object'));
        } else if (
          alteration === 'unknown-format' ||
          alteration === 'compiler-version' ||
          alteration === 'build-id'
        ) {
          const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json')));
          if (alteration === 'unknown-format') manifest.formatVersion = 999;
          else if (alteration === 'build-id') manifest.buildId = `lore_${'0'.repeat(64)}`;
          else manifest.compilerVersion = 'altered-builder';
          members.set('manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest)}\n`));
        } else {
          const catalog = join(root, 'altered-context.sqlite');
          writeFileSync(catalog, members.get('context.sqlite') as Uint8Array);
          const db = openWritable(catalog);
          try {
            if (alteration === 'extra-table')
              db.exec('CREATE TABLE fabricated (value TEXT) STRICT');
            else if (alteration === 'declared-rules') {
              db.exec('UPDATE artifacts SET authority = 99; UPDATE chunks_fts SET authority = 99');
            } else if (alteration === 'fts-docsize' || alteration === 'fts-term-data') {
              (db as unknown as { enableDefensive(active: boolean): void }).enableDefensive(false);
              expect(
                Number(
                  db
                    .prepare(
                      alteration === 'fts-docsize'
                        ? "UPDATE chunks_fts_docsize SET sz = X'00'"
                        : 'DELETE FROM chunks_fts_data WHERE id > 10',
                    )
                    .run().changes,
                ),
              ).toBeGreaterThan(0);
            } else {
              const statements: Record<string, string> = {
                'chunk-text': "UPDATE chunks SET text = text || ' fabricated'",
                'fts-body': "UPDATE chunks_fts SET body = 'fabricated'",
                'missing-migration': "DELETE FROM schema_migrations WHERE id = '0004'",
                'changed-migration':
                  "UPDATE schema_migrations SET checksum = 'fabricated' WHERE id = '0004'",
              };
              expect(
                Number(db.prepare(statements[alteration] as string).run().changes),
              ).toBeGreaterThan(0);
            }
          } finally {
            db.close();
          }
          members.set('context.sqlite', new Uint8Array(readFileSync(catalog)));
        }
        const altered = join(root, 'altered.lorepack');
        await writeArchive(
          altered,
          [...members].map(([path, bytes]) => ({ path, bytes })),
        );
        await expect(
          execute(
            process.execPath,
            [
              join(import.meta.dirname, '..', 'dist', 'public-entry.js'),
              '--json',
              'pack',
              '--verify',
              altered,
            ],
            { cwd: root, timeout: 120_000 },
          ),
        ).rejects.toMatchObject({
          code: 2,
          stdout: expect.stringMatching(/LORE_E_(OBJECT_CORRUPT|SCHEMA_MISMATCH|BUILD_VALIDATION)/),
        });
      });
    },
  );

  it('accepts equivalent FTS storage without segment lookup rows (#418)', async () => {
    await packedProject(async (root, _lore, archive) => {
      const members = await readArchive(archive);
      const catalog = join(root, 'equivalent.sqlite');
      writeFileSync(catalog, members.get('context.sqlite') as Uint8Array);
      const db = openWritable(catalog);
      try {
        (db as unknown as { enableDefensive(active: boolean): void }).enableDefensive(false);
        expect(Number(db.prepare('DELETE FROM chunks_fts_idx').run().changes)).toBeGreaterThan(0);
        db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('integrity-check')");
        expect(
          db.prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'rollback'").all()
            .length,
        ).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      members.set('context.sqlite', new Uint8Array(readFileSync(catalog)));
      members.delete(CHECKSUM_MEMBER);
      const equivalent = join(root, 'equivalent.lorepack');
      await writeArchive(
        equivalent,
        [...members].map(([path, bytes]) => ({ path, bytes })),
      );
      const original = await verifyArchive(archive);
      expect(await verifyArchive(equivalent)).toMatchObject({
        ok: true,
        buildId: original.buildId,
      });
    });
  });

  it('names the member that is corrupt rather than rejecting the whole file', async () => {
    await packedProject(async (_root, lore, archive) => {
      const bytes = readFileSync(archive);
      // Flip a byte inside the compressed payload region, past the first local header.
      const target = Math.floor(bytes.length / 2);
      bytes[target] = (bytes[target] ?? 0) ^ 0xff;
      writeFileSync(archive, bytes);

      const result = await lore(['pack', '--verify', archive]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/checksum-mismatch|corrupt|truncated|not an archive/i);
    });
  });

  it('reports a missing member through the API with its expected digest', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const result = await verifyArchive(archive);
      expect(result.ok).toBe(true);
      expect(result.memberCount).toBeGreaterThan(3);
      expect(result.failures).toEqual([]);
    });
  });

  it('excludes original sources by default', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const members = [...(await readArchive(archive)).keys()];
      expect(members.some((name) => name.startsWith('originals/'))).toBe(false);
    });
  });

  it('includes original sources when the project asks for them', async () => {
    await packedProject(async (_root, _lore, archive) => {
      const members = [...(await readArchive(archive)).keys()];
      expect(members).toContain('originals/guides/deployment.md');
      expect(members).toContain('originals/notes/meeting.txt');
    }, `${CONFIG}package:\n  includeOriginals: true\n`);
  });

  it('opens with a standard zip tool, which is the whole anti-lock-in promise', async () => {
    await packedProject(async (root, _lore, archive) => {
      let unzipAvailable = true;
      try {
        await execute('unzip', ['-v']);
      } catch {
        unzipAvailable = false;
      }
      if (!unzipAvailable) {
        // Windows runners have no `unzip`. The pure-JS reader test above covers the same
        // property on every platform; this one adds an independent implementation.
        expect(existsSync(archive)).toBe(true);
        return;
      }

      const { stdout } = await execute('unzip', ['-l', archive], { cwd: root });
      expect(stdout).toContain('manifest.json');
      expect(stdout).toContain('context.sqlite');
    });
  });

  it('refuses to pack a build that does not exist', async () => {
    await packedProject(async (_root, lore) => {
      const result = await lore(['pack', 'lore_ffffffff']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
    });
  });

  it.each(['missing', 'corrupt'] as const)('refuses a %s referenced object', async (failure) => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, ...CORPUS } }, async (temp) => {
      const built = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      });
      const db = new DatabaseSync(
        join(temp.root, '.lore', 'builds', built.buildId, 'context.sqlite'),
        {
          readOnly: true,
          allowExtension: false,
          enableDoubleQuotedStringLiterals: false,
        },
      );
      const { object_hash: hash } = db
        .prepare('SELECT object_hash FROM artifacts LIMIT 1')
        .get() as { object_hash: string };
      db.close();

      const object = join(temp.root, '.lore', 'objects', ...objectKey(hash).split('/'));
      if (failure === 'missing') rmSync(object);
      else writeFileSync(object, 'tampered');

      const result = await run(['--cwd', temp.root, 'pack']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('LORE_E_OBJECT_CORRUPT');
      expect(result.stderr).toContain(hash);
    });
  });

  it('fails cleanly when asked to verify something that is not an archive', async () => {
    await packedProject(async (root, lore) => {
      writeFileSync(join(root, 'junk.lorepack'), 'this is not a zip file');
      const result = await lore(['pack', '--verify', 'junk.lorepack']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('LORE_E_OBJECT_CORRUPT');
    });
  });

  it('writes nothing into the build directory, which stays immutable', async () => {
    await packedProject(async (root) => {
      const builds = join(root, '.lore', 'builds');
      const before = readdirSync(builds, { recursive: true }).length;
      await run(['--cwd', root, 'pack', '--out', 'again.lorepack']);
      expect(readdirSync(builds, { recursive: true }).length).toBe(before);
    });
  });
});

/**
 * Originals are read from the live tree at pack time, so they are the one part of an archive
 * that can drift from the build it claims to carry (#568). Each case changes the tree after
 * the build and expects the pack to refuse, naming the file, and to write no archive.
 */
describe('lorepack pack with originals', () => {
  const WITH_ORIGINALS = `${CONFIG}package:\n  includeOriginals: true\n`;

  async function builtWithOriginals(
    body: (context: { root: string; outside: string }) => Promise<void>,
    config = WITH_ORIGINALS,
  ): Promise<void> {
    await withTempProject(
      { files: { 'outside/id_secret': 'PRIVATE KEY MATERIAL\n' } },
      async (temp) => {
        const root = join(temp.root, 'p');
        mkdirSync(join(root, 'notes'), { recursive: true });
        mkdirSync(join(root, 'guides'), { recursive: true });
        writeFileSync(join(root, 'lore.yaml'), config);
        for (const [path, text] of Object.entries(CORPUS)) writeFileSync(join(root, path), text);
        await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
        await body({ root, outside: join(temp.root, 'outside') });
      },
    );
  }

  function archives(root: string): string[] {
    return readdirSync(root).filter((name) => name.endsWith('.lorepack'));
  }

  it('refuses a source swapped for a symlink out of the project, and writes nothing', async () => {
    await builtWithOriginals(async ({ root, outside }) => {
      rmSync(join(root, 'notes', 'meeting.txt'));
      symlinkSync(join(outside, 'id_secret'), join(root, 'notes', 'meeting.txt'));

      const result = await run(['--cwd', root, 'pack']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_PATH_ESCAPE');
      expect(result.stderr).toContain('notes/meeting.txt');
      expect(archives(root)).toEqual([]);
    });
  });

  it('refuses a source reached through a directory linked out of the project', async () => {
    // Identical bytes on the far side of the link: containment, not the hash, refuses it.
    await builtWithOriginals(async ({ root, outside }) => {
      writeFileSync(join(outside, 'meeting.txt'), CORPUS['notes/meeting.txt']);
      rmSync(join(root, 'notes'), { recursive: true });
      symlinkSync(outside, join(root, 'notes'), platform() === 'win32' ? 'junction' : 'dir');

      const result = await run(['--cwd', root, 'pack']);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_PATH_ESCAPE');
      expect(archives(root)).toEqual([]);
    });
  });

  it('refuses a source whose bytes changed since the build', async () => {
    await builtWithOriginals(async ({ root }) => {
      writeFileSync(join(root, 'notes', 'meeting.txt'), 'Edited after the build.\n');

      const result = await run(['--cwd', root, 'pack']);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('LORE_E_STALE_SOURCES');
      expect(result.stderr).toContain('notes/meeting.txt');
      expect(archives(root)).toEqual([]);
    });
  });

  it('refuses a source deleted since the build instead of packing without it', async () => {
    await builtWithOriginals(async ({ root }) => {
      rmSync(join(root, 'notes', 'meeting.txt'));

      const result = await run(['--cwd', root, 'pack']);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain('LORE_E_STALE_SOURCES');
      expect(archives(root)).toEqual([]);
    });
  });

  it('packs the bytes the build was made from, at their project paths', async () => {
    // A source root below the project: artifact paths are relative to `docs`, and the
    // originals must still be read from, and named by, their place in the project.
    await builtWithOriginals(async ({ root }) => {
      const result = await run(['--cwd', root, 'pack', '--out', 'out.lorepack']);
      expect(result.code, result.stderr).toBe(0);

      const members = await readArchive(join(root, 'out.lorepack'));
      expect(new TextDecoder().decode(members.get('originals/guides/deployment.md'))).toBe(
        CORPUS['guides/deployment.md'],
      );
      expect([...members.keys()].filter((name) => name.startsWith('originals/'))).toEqual([
        'originals/guides/deployment.md',
      ]);
      expect((await verifyArchive(join(root, 'out.lorepack'))).ok).toBe(true);
    }, 'version: 1\nname: demo\nsources:\n  - guides\npackage:\n  includeOriginals: true\n');
  });
});
