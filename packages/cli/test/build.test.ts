import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectLock } from '@lorepack/backend-local';
import {
  type BuildIdInputs,
  buildManifestSchema,
  deriveBuildId,
  hashCanonical,
  type LoadedConfig,
  loadConfig,
  ProgressBus,
} from '@lorepack/core';
import { ParserHost } from '@lorepack/parsers';
import {
  canonicalJson,
  formula,
  inlineString,
  makeDocx,
  makePdf,
  makeXlsx,
  number,
  paragraph,
  row,
  withTempProject,
} from '@lorepack/test-support';
import { describe, expect, it, vi } from 'vitest';
import { type BuildResult, readStableSourceBytes, runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function project<T>(
  files: Record<string, string>,
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, async (temp) =>
    body(temp.root, (args) => run(['--cwd', temp.root, ...args])),
  );
}

function build(root: string, overrides: Record<string, unknown> = {}) {
  return runBuild({
    config: loadConfig({ cwd: root }),
    progress: new ProgressBus(),
    ...overrides,
  });
}

function buildsIn(root: string): string[] {
  const directory = join(root, '.lore', 'builds');
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe('lorepack build', () => {
  it('rejects source bytes that no longer match the fingerprint', async () => {
    await project({ 'a.md': '# Original\n' }, async (root) => {
      const original = new TextEncoder().encode('# Original\n');
      const { discover, fingerprintSources } = await import('@lorepack/compiler');
      const captured = await fingerprintSources({
        artifacts: discover({ config: loadConfig({ cwd: root }) }).artifacts,
      });
      const artifact = captured.artifacts[0];
      assert(artifact);
      expect(readStableSourceBytes(artifact)).toEqual(original);
      writeFileSync(join(root, 'a.md'), '# Changed\n', 'utf8');

      expect(() => readStableSourceBytes(artifact)).toThrowError(
        expect.objectContaining({ code: 'LORE_E_STALE_SOURCES', path: 'a.md' }),
      );
      expect(existsSync(join(root, '.lore', 'cache'))).toBe(false);
    });
  });

  it('stores well-formed, overlapping chunks for astral text split across pieces (#591)', async () => {
    // An odd prefix puts every emoji pair across an even offset, so a hard cut at the budget
    // lands inside one unless the chunker steps off it.
    const body = `x${'\u{1F600}'.repeat(6000)}`;
    await project({ 'emoji.md': `# Emoji\n\n${body}\n` }, async (root) => {
      const result = await build(root);
      const { openReadOnly } = await import('@lorepack/backend-local');
      const db = openReadOnly(join(root, '.lore', 'builds', result.buildId, 'context.sqlite'));
      try {
        const rows = db.prepare('SELECT id, text FROM chunks').all() as {
          id: string;
          text: string;
        }[];
        const pieces = rows
          .map((row) => ({ index: Number(row.id.split('@').at(-1)), text: row.text }))
          .sort((a, b) => a.index - b.index)
          .map((row) => row.text.replace(/^Emoji\n\n/, ''));
        expect(pieces.length).toBeGreaterThan(2);
        for (const piece of pieces) {
          expect(piece.isWellFormed()).toBe(true);
          expect(piece).not.toContain('\uFFFD');
        }
        for (let index = 1; index < pieces.length; index += 1) {
          const head = [...(pieces[index] as string)].slice(0, 10).join('');
          expect(pieces[index - 1]?.endsWith(head) || pieces[index - 1]?.includes(head)).toBe(true);
        }
      } finally {
        db.close();
      }
    });
  });

  it('turns a directory into a verified, active build', async () => {
    await project(
      { 'docs/a.md': '# A\n\nAlpha text.', 'docs/b.md': '# B\n\nBeta text.' },
      async (root) => {
        const result = await build(root);

        expect(result.created).toBe(true);
        expect(result.activated).toBe(true);
        expect(result.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
        expect(result.counts.artifacts).toBe(2);
        expect(result.counts.chunks).toBeGreaterThan(0);
        expect(buildsIn(root)).toEqual([result.buildId]);
      },
    );
  });

  it('writes a manifest that validates against the committed schema', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const result = await build(root);
      const manifest = JSON.parse(
        readFileSync(join(root, '.lore', 'builds', result.buildId, 'manifest.json'), 'utf8'),
      );
      expect(buildManifestSchema.safeParse(manifest).success).toBe(true);
      expect(manifest.buildId).toBe(result.buildId);
    });
  });

  it('seals complete build identity inputs independently of the source directory (#418)', async () => {
    const reports: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await project({ 'a.md': '# A\n\nText.' }, async (root) => {
        const result = await build(root);
        const directory = join(root, '.lore', 'builds', result.buildId);
        const report = readFileSync(join(directory, 'reports', 'build-id-inputs.json'), 'utf8');
        reports.push(report);
        const inputs = JSON.parse(report) as BuildIdInputs;
        const manifest = buildManifestSchema.parse(
          JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
        );
        expect(deriveBuildId(inputs)).toBe(result.buildId);
        expect(inputs.canonicalRoots).toEqual(manifest.canonicalRoots);
        expect(inputs.compilerVersion).toBe(manifest.compilerVersion);
        expect(hashCanonical(inputs.effectiveConfig)).toBe(manifest.configurationHash);
        expect(Object.keys(inputs.parserVersions).sort()).toEqual([
          'csv',
          'docx',
          'html',
          'markdown',
          'pdf-text',
          'text',
          'xlsx',
        ]);
        expect(report).not.toContain(root);
        expect(inputs).not.toHaveProperty('corpusId');
        expect(inputs).not.toHaveProperty('namespaceId');
      });
    }
    expect(reports[1]).toBe(reports[0]);
  });

  it('produces the same build id from identical sources in two different directories', async () => {
    // Determinism is the product invariant, so identity must not depend on where the
    // project happens to live.
    const files = { 'lore.yaml': CONFIG, 'a.md': '# A\n\nText.', 'nested/b.md': '# B\n\nMore.' };
    const first = await withTempProject(
      { files },
      async (temp) => (await build(temp.root)).buildId,
    );
    const second = await withTempProject(
      { files },
      async (temp) => (await build(temp.root)).buildId,
    );
    expect(second).toBe(first);
  });

  it('short-circuits an unchanged project without creating a second build directory', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);
      const second = await build(root);

      expect(second.created).toBe(false);
      expect(second.buildId).toBe(first.buildId);
      expect(buildsIn(root)).toEqual([first.buildId]);
    });
  });

  it('does not record or activate a build when sealing reports no destination', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nDifferent text.', 'utf8');

      await expect(
        build(root, {
          seal: () => ({ sealed: false }),
        }),
      ).rejects.toMatchObject({ code: 'LORE_E_INTERNAL' });

      expect(buildsIn(root)).toEqual([first.buildId]);
      await expect(build(root, { activate: false })).resolves.toMatchObject({
        buildId: expect.not.stringMatching(first.buildId),
        created: true,
      });
    });
  });

  it('creates a new build when a source changes, leaving the old one intact', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nDifferent text.', 'utf8');
      const second = await build(root);

      expect(second.buildId).not.toBe(first.buildId);
      expect(buildsIn(root)).toHaveLength(2);
      expect(existsSync(join(root, '.lore', 'builds', first.buildId, 'manifest.json'))).toBe(true);
    });
  });

  it('reflects a deleted file in the next build', async () => {
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root) => {
      const first = await build(root);
      expect(first.counts.artifacts).toBe(2);

      rmSync(join(root, 'b.md'));
      const second = await build(root);
      expect(second.counts.artifacts).toBe(1);
      expect(second.buildId).not.toBe(first.buildId);
    });
  });

  it('reuses cached parses on a rebuild instead of reparsing everything', async () => {
    await project(
      { 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.', 'c.md': '# C\n\nThird.' },
      async (root) => {
        const first = await build(root);
        expect(first.rebuiltArtifacts).toBe(3);
        expect(first.reusedArtifacts).toBe(0);

        writeFileSync(join(root, 'a.md'), '# A\n\nEdited text.', 'utf8');
        const second = await build(root);

        expect(second.rebuiltArtifacts).toBe(1);
        expect(second.reusedArtifacts).toBe(2);
      },
    );
  });

  it('keeps two identical files at different paths as two artifacts', async () => {
    // The parse cache is keyed on the artifact id as well as the content. Without the
    // path, identical content at two paths shared one cache entry and the second file
    // inherited the first one's record.
    await project({ 'a.md': '# Same\n\nText.', 'copy/a.md': '# Same\n\nText.' }, async (root) => {
      const result = await build(root);
      expect(result.counts.artifacts).toBe(2);

      const paths = readFileSync(
        join(root, '.lore', 'builds', result.buildId, 'manifest.json'),
        'utf8',
      );
      expect(JSON.parse(paths).counts.artifacts).toBe(2);
    });
  });

  it('produces a different build when a file is renamed but not edited', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);
      renameSync(join(root, 'a.md'), join(root, 'renamed.md'));
      const second = await build(root);

      expect(second.created).toBe(true);
      expect(second.buildId).not.toBe(first.buildId);
    });
  });

  it('leaves the active pointer alone with --no-activate', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nChanged.', 'utf8');
      const candidate = await build(root, { activate: false });

      expect(candidate.created).toBe(true);
      expect(candidate.activated).toBe(false);
      expect(buildsIn(root)).toHaveLength(2);

      const status = await run(['--cwd', root, '--json', 'status']);
      expect((JSON.parse(status.stdout) as { activeBuildId: string }).activeBuildId).toBe(
        first.buildId,
      );
    });
  });

  it('writes the lockfile after a successful build and enforces it under --frozen', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      await build(root);
      expect(existsSync(join(root, 'lore.lock'))).toBe(true);

      writeFileSync(join(root, 'a.md'), '# A\n\nChanged.', 'utf8');
      await expect(build(root, { frozen: true })).resolves.toMatchObject({ created: true });
    });
  });

  it('fails --frozen when the lockfile would be created', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      await expect(build(root, { frozen: true })).rejects.toThrowError(/LOCKFILE_DRIFT|lore.lock/);
      expect(buildsIn(root)).toEqual([]);
    });
  });

  it('excludes a file whose bytes are not text, and builds the rest', async () => {
    // This used to assert LORE_E_PARSE_FAILED. A UTF-16 file is not a supported file that
    // failed to parse, it is an unsupported file, and section 6.9 says to exclude it with a
    // warning (#165). The build succeeding is the point: one stray export must not stop a
    // project from having any context at all.
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const first = await build(root);

      writeFileSync(join(root, 'broken.md'), Buffer.from('﻿# Title', 'utf16le'));
      const second = await build(root);

      expect(second.warnings).toBe(1);
      expect(second.counts.artifacts).toBe(1);
      expect(second.buildId).toBe(first.buildId);
    });
  });

  it('leaves the project clean after excluding one, rather than asking for a pointless build', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      writeFileSync(join(root, 'broken.md'), Buffer.from('﻿# Title', 'utf16le'));
      await build(root);

      const status = await run(['--cwd', root, '--json', 'status']);
      expect((JSON.parse(status.stdout) as { sourceState: string }).sourceState).toBe('clean');
    });
  });

  it('leaves no candidate directory behind after a failure', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      // Lockfile drift is the failure this phase can trigger on demand. The parse-failure
      // path stays in place for the parsers that can genuinely fail on decodable input
      // (PDF, DOCX, XLSX in Phase 5); markdown and text cannot.
      await expect(build(root, { frozen: true })).rejects.toThrow();

      const temporary = join(root, '.lore', 'tmp');
      expect(existsSync(temporary) ? readdirSync(temporary) : []).toEqual([]);
      expect(buildsIn(root)).toEqual([]);
    });
  });
});

describe('cancellation', () => {
  it('leaves builds/ and the active pointer untouched when aborted mid-build', async () => {
    // The invariant that matters is not tidiness. A leftover temp directory is untidy; a
    // mutated builds/ is a corrupted promise.
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root) => {
      const first = await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nChanged.', 'utf8');

      const controller = new AbortController();
      const progress = new ProgressBus();
      // Abort as soon as the first stage reports, which lands mid-pipeline.
      progress.subscribe((event) => {
        if (event.type === 'stage-started') controller.abort();
      });

      await expect(
        runBuild({ config: loadConfig({ cwd: root }), progress, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'LORE_E_CANCELLED' });

      expect(buildsIn(root)).toEqual([first.buildId]);
      const status = await run(['--cwd', root, '--json', 'status']);
      expect((JSON.parse(status.stdout) as { activeBuildId: string }).activeBuildId).toBe(
        first.buildId,
      );
    });
  });

  it('releases the project lock after a cancelled build', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const controller = new AbortController();
      const progress = new ProgressBus();
      progress.subscribe((event) => {
        if (event.type === 'stage-started') controller.abort();
      });
      await expect(
        runBuild({ config: loadConfig({ cwd: root }), progress, signal: controller.signal }),
      ).rejects.toThrow();

      // The next build must not report a held lock.
      await expect(build(root)).resolves.toMatchObject({ created: true });
    });
  });
});

describe('candidates left by killed builds', () => {
  it('are swept by the next build (#572)', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const leftover = join(root, '.lore', 'tmp', 'candidate-KILLED');
      mkdirSync(leftover, { recursive: true });
      writeFileSync(join(leftover, 'context.sqlite'), 'half a database');

      await expect(build(root)).resolves.toMatchObject({ created: true });
      expect(existsSync(leftover)).toBe(false);
    });
  });
});

describe('concurrency', () => {
  it('serializes two simultaneous builds so exactly one does the work', async () => {
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root) => {
      const results = await Promise.all([build(root), build(root)]);

      // The loser waits on the lock, then finds the build already recorded. Two winners
      // would mean the lock did not serialize; two build directories from one source
      // state would mean identity is not content-derived.
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results[0]?.buildId).toBe(results[1]?.buildId);
      expect(buildsIn(root)).toHaveLength(1);
    });
  });

  it('names the holding pid when the lock cannot be taken', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      // A live process that is not this one: the lock must refuse rather than reclaim.
      const lock = new ProjectLock(join(root, '.lore', 'lock'), { ownerPid: process.ppid });
      await lock.acquire();
      try {
        await expect(
          runBuild({
            config: loadConfig({ cwd: root }),
            progress: new ProgressBus(),
            lockWaitMs: 50,
          }),
        ).rejects.toMatchObject({
          code: 'LORE_E_LOCK_HELD',
          message: expect.stringMatching(/pid \d+/),
        });
      } finally {
        lock.release();
      }
    });
  });

  it('refuses a lock taken on another host instead of reclaiming it (#565)', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const lock = join(root, '.lore', 'lock');
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: 999_999, hostname: 'other-host-nfs', acquiredAt: Date.now() }),
      );
      await expect(
        runBuild({
          config: loadConfig({ cwd: root }),
          progress: new ProgressBus(),
          lockWaitMs: 50,
        }),
      ).rejects.toMatchObject({
        code: 'LORE_E_LOCK_HELD',
        message: expect.stringContaining('on host other-host-nfs'),
      });
      expect(existsSync(join(lock, 'owner.json'))).toBe(true);
    });
  });

  it('reclaims a lock whose pid was reused by a process that started later (#565)', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const lock = join(root, '.lore', 'lock');
      mkdirSync(lock, { recursive: true });
      // The pid is this test's parent, which is alive. The recorded start is not its start,
      // so whatever took the lock has exited and the pid now names something else.
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({
          pid: process.ppid,
          start: process.platform === 'linux' ? 'linux:0' : 'epoch:0',
          hostname: hostname(),
          acquiredAt: Date.now(),
          token: randomUUID(),
        }),
      );
      await expect(
        runBuild({
          config: loadConfig({ cwd: root }),
          progress: new ProgressBus(),
          lockWaitMs: 5_000,
        }),
      ).resolves.toMatchObject({ created: true });
    });
  });

  it('reports who it is waiting for instead of appearing to hang', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      const lock = new ProjectLock(join(root, '.lore', 'lock'), { ownerPid: process.ppid });
      await lock.acquire();

      const messages: string[] = [];
      const progress = new ProgressBus();
      progress.subscribe((event) => {
        if (event.type === 'diagnostic') messages.push(event.message);
      });

      // Released while the build is already waiting, so the wait is real.
      setTimeout(() => lock.release(), 150);
      const result = await runBuild({ config: loadConfig({ cwd: root }), progress });

      expect(result.created).toBe(true);
      expect(messages.join('\n')).toMatch(/Waiting for the project lock held by pid \d+/);
    });
  });
});

describe('what the build says when it cannot read a file', () => {
  // chmod is a POSIX concept. On Windows the equivalent needs an ACL API Node does not
  // expose, and a test that silently does nothing is worse than one that says why.
  const posixOnly = process.platform === 'win32';

  it.skipIf(posixOnly)(
    'names the file and the fix, and does not call it an internal error',
    async () => {
      await project({ 'a.md': '# A\n\nText.', 'locked.md': '# Locked\n\nText.' }, async (root) => {
        chmodSync(join(root, 'locked.md'), 0o000);
        try {
          await expect(build(root)).rejects.toMatchObject({
            code: 'LORE_E_SOURCE_UNREADABLE',
            path: 'locked.md',
          });
        } finally {
          chmodSync(join(root, 'locked.md'), 0o644);
        }
      });
    },
  );

  it.skipIf(posixOnly)('builds normally once the permission is fixed', async () => {
    await project({ 'a.md': '# A\n\nText.', 'locked.md': '# Locked\n\nText.' }, async (root) => {
      chmodSync(join(root, 'locked.md'), 0o000);
      await expect(build(root)).rejects.toThrow();
      chmodSync(join(root, 'locked.md'), 0o644);

      await expect(build(root)).resolves.toMatchObject({ created: true });
    });
  });
});

describe('lorepack build command', () => {
  it('reports the build and its counts, exiting 0', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      const result = await lore(['build']);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Build lore_[0-9a-f]{64}/);
      expect(result.stdout).toContain('1 artifact');
      expect(result.stdout, 'counted nouns must agree in number (#150)').not.toContain(
        '1 artifacts',
      );
      expect(result.stdout).toContain('Activated');
    });
  });

  it('says so plainly when there is nothing to do', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      await lore(['build']);
      const second = await lore(['build']);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('No changes');
    });
  });

  it('emits a machine-readable result under --json with nothing else on stdout', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      const result = await lore(['--json', 'build']);
      const parsed = JSON.parse(result.stdout) as {
        buildId: string;
        counts: { chunks: number };
        warnings: number;
        durationMs: number;
      };
      expect(parsed.buildId).toMatch(/^lore_/);
      expect(parsed.counts.chunks).toBeGreaterThan(0);
      expect(parsed.warnings).toBe(0);
      expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('reports an excluded file as a warning and still exits 0', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      writeFileSync(join(root, 'broken.md'), Buffer.from('﻿# Title', 'utf16le'));
      const result = await lore(['--json', 'build']);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { warnings: number }).warnings).toBe(1);
    });
  });

  it('exits 2 on lockfile drift under --frozen', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (_root, lore) => {
      const result = await lore(['build', '--frozen']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('LORE_E_LOCKFILE_DRIFT');
    });
  });
});

const CACHE_CONFIG = 'version: 1\nname: cache-contract\nsources:\n  - docs\n';
type CacheSources = Readonly<Record<string, string | Uint8Array>>;

async function mixedCacheSources(): Promise<CacheSources> {
  return {
    'docs/guide.md': `# Release\n\n${Array.from({ length: 160 }, (_, index) => `Condition ${index}: record owner approval before activation.`).join(' ')}\n`,
    'docs/notes.txt': 'Keep the approved build.\n\nRollback does not recompile.\n',
    'docs/worker.ts': 'export const approved = true;\n',
    'docs/page.html': '<main><h1>Release</h1><p>Ask the owner before activation.</p></main>',
    'docs/guide.docx': await makeDocx({ body: paragraph('Owner approval', 'CustomCallout') }),
    'docs/guide.pdf': makePdf([
      { lines: ['Keep the approved build.'] },
      { lines: [], image: true },
    ]),
    'docs/prices.csv': 'sku,price\nA-1,12.5\nB-2,8\n',
    'docs/prices.xlsx': await makeXlsx({
      sheets: [
        {
          name: 'Products',
          rows: [
            row(1, [inlineString('A1', 'sku'), inlineString('B1', 'price')]),
            row(2, [inlineString('A2', 'A-1'), formula('B2', '10+2.5', 12.5)]),
            row(3, [inlineString('A3', 'B-2'), number('B3', 8)]),
          ].join(''),
        },
      ],
    }),
  };
}

function writeCacheSources(root: string, sources: CacheSources, reverse = false): void {
  const entries = Object.entries(sources);
  if (reverse) entries.reverse();
  for (const [path, bytes] of entries) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function cacheBuildConfig(root: string, policy: 'baseline' | 'rules' | 'chunking'): LoadedConfig {
  const config = loadConfig({ cwd: root });
  if (policy !== 'chunking') return config;
  return {
    ...config,
    effective: {
      ...config.effective,
      chunking: { targetTokens: 80, maximumTokens: 160, overlapTokens: 10 },
    },
  };
}

function logicalCacheSnapshot(root: string, buildId: string) {
  const manifest = buildManifestSchema.parse(
    JSON.parse(readFileSync(join(root, '.lore/builds', buildId, 'manifest.json'), 'utf8')),
  );
  const db = new DatabaseSync(join(root, '.lore/builds', buildId, 'context.sqlite'), {
    readOnly: true,
  });
  try {
    const artifacts = db.prepare('SELECT * FROM artifacts ORDER BY id').all();
    const tables = db.prepare('SELECT * FROM tables ORDER BY id').all();
    const objects = artifacts.map((artifact) => {
      const hash = String(artifact.object_hash);
      const bytes = readFileSync(
        join(root, '.lore/objects/sha256', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4)),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      return { hash, body: bytes.toString('utf8') };
    });
    const rows = tables.map((table) => {
      const name = String(table.sql_name);
      expect(name).toMatch(/^t_[a-z0-9_]+$/);
      return {
        tableId: table.id,
        rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      };
    });
    return {
      manifest,
      artifacts,
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
      chunks: db.prepare('SELECT * FROM chunks ORDER BY id').all(),
      supersessions: db
        .prepare('SELECT * FROM supersessions ORDER BY artifact_id, superseded_id')
        .all(),
      warnings: db
        .prepare(
          'SELECT code, class, path, message FROM build_warnings ORDER BY code, class, path, message',
        )
        .all(),
      index: db
        .prepare(
          'SELECT chunk_id, artifact_id, status, authority, path, title, heading, body FROM chunks_fts ORDER BY chunk_id',
        )
        .all(),
      tables,
      columns: db.prepare('SELECT * FROM table_columns ORDER BY table_id, ordinal').all(),
      rows,
      objects,
    };
  } finally {
    db.close();
  }
}

function assertCacheLandmarks(snapshot: ReturnType<typeof logicalCacheSnapshot>): void {
  expect(snapshot.artifacts).toHaveLength(8);
  expect(new Set(snapshot.artifacts.map((artifact) => artifact.parser_id))).toEqual(
    new Set(['markdown', 'text', 'code', 'html', 'docx', 'pdf-text', 'csv', 'xlsx']),
  );
  expect(snapshot.warnings.map((warning) => warning.code)).toEqual(
    expect.arrayContaining(['docx-unmapped-style', 'pdf-pages-without-text']),
  );
  expect(
    snapshot.warnings.find((warning) => warning.code === 'pdf-pages-without-text'),
  ).toMatchObject({ message: expect.stringContaining('Pages: 2.') });
  expect(snapshot.tables).toHaveLength(2);
  for (const table of snapshot.rows) {
    expect(table.rows.map((record) => Object.values(record))).toEqual([
      ['A-1', 12.5],
      ['B-2', 8],
    ]);
  }
  const xlsx = snapshot.tables.find((table) => table.sheet === 'Products');
  expect(xlsx).toMatchObject({
    relative_path: 'prices.xlsx',
    cell_range: 'A1:B3',
    row_count: 2,
  });
  expect(JSON.parse(String(xlsx?.metadata))).toMatchObject({ formulas: ['B2=10+2.5'] });
  const pdf = snapshot.artifacts.find((artifact) => artifact.relative_path === 'guide.pdf');
  const paragraphs = snapshot.nodes.filter(
    (node) => node.artifact_id === pdf?.id && node.kind === 'paragraph',
  );
  expect(paragraphs.map((node) => JSON.parse(String(node.metadata)).page)).toEqual([1]);
  const pdfChunks = snapshot.chunks.filter((chunk) => chunk.artifact_id === pdf?.id);
  expect(pdfChunks.length).toBeGreaterThan(0);
  expect(new Set(pdfChunks.map((chunk) => chunk.page))).toEqual(new Set([1]));
  for (const table of snapshot.tables) {
    expect(
      snapshot.columns
        .filter((column) => column.table_id === table.id)
        .map((column) => [column.name, column.type]),
    ).toEqual([
      ['sku', 'text'],
      ['price', 'real'],
    ]);
  }
}

describe('independent cold/warm build equivalence, issue414', () => {
  it.each(['baseline', 'source edit', 'rules', 'chunking', 'missing body'] as const)(
    'seals identical logical output from independent caches after %s',
    async (change) => {
      const sources = await mixedCacheSources();
      const paths = Object.keys(sources)
        .map((path) => path.slice('docs/'.length))
        .sort();
      await withTempProject({ files: { 'lore.yaml': CACHE_CONFIG } }, async (seed) => {
        writeCacheSources(seed.root, sources);
        const initial = await build(seed.root);
        expect(initial.rebuiltArtifacts).toBe(8);
        expect(initial.reusedArtifacts).toBe(0);
        const before = logicalCacheSnapshot(seed.root, initial.buildId);
        assertCacheLandmarks(before);
        const targetSources =
          change === 'source edit'
            ? { ...sources, 'docs/guide.md': '# Revised release\n\nRequire written approval.\n' }
            : sources;
        const policy = change === 'rules' || change === 'chunking' ? change : 'baseline';
        const targetConfig =
          change === 'rules'
            ? `${CACHE_CONFIG}rules:\n  - match: 'guide.md'\n    authority: 90\n`
            : CACHE_CONFIG;
        await withTempProject({ files: { 'lore.yaml': targetConfig } }, async (warm) => {
          await withTempProject({ files: { 'lore.yaml': targetConfig } }, async (cold) => {
            writeCacheSources(warm.root, targetSources);
            writeCacheSources(cold.root, targetSources, true);
            cpSync(seed.path('.lore/cache/parse'), warm.path('.lore/cache/parse'), {
              recursive: true,
            });
            cpSync(seed.path('.lore/objects'), warm.path('.lore/objects'), { recursive: true });
            if (change === 'missing body') {
              const artifact = before.artifacts.find((entry) => entry.relative_path === 'guide.md');
              const hash = String(artifact?.object_hash);
              expect(hash).toMatch(/^[a-f0-9]{64}$/);
              rmSync(
                warm.path(
                  `.lore/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`,
                ),
              );
            }
            expect(existsSync(warm.path('.lore/builds'))).toBe(false);
            expect(existsSync(warm.path('.lore/state.sqlite'))).toBe(false);
            const actualParse = vi.spyOn(ParserHost.prototype, 'parse');
            try {
              const warmBuild = await build(warm.root, {
                config: cacheBuildConfig(warm.root, policy),
              });
              const expectedWarmParses =
                change === 'baseline'
                  ? ['prices.csv', 'prices.xlsx']
                  : change === 'source edit' || change === 'missing body'
                    ? ['guide.md', 'prices.csv', 'prices.xlsx']
                    : paths;
              expect(actualParse.mock.calls.map(([, input]) => input.relativePath).sort()).toEqual(
                expectedWarmParses,
              );
              expect(warmBuild.rebuiltArtifacts).toBe(expectedWarmParses.length);
              expect(warmBuild.reusedArtifacts).toBe(8 - expectedWarmParses.length);
              actualParse.mockClear();
              const coldBuild = await build(cold.root, {
                config: cacheBuildConfig(cold.root, policy),
              });
              expect(actualParse.mock.calls.map(([, input]) => input.relativePath).sort()).toEqual(
                paths,
              );
              expect(coldBuild.rebuiltArtifacts).toBe(8);
              expect(coldBuild.reusedArtifacts).toBe(0);
              expect(warmBuild.created).toBe(true);
              expect(coldBuild.created).toBe(true);
              expect(warmBuild.buildId).toBe(coldBuild.buildId);
              expect(warm.root).not.toBe(cold.root);
              const warmSnapshot = logicalCacheSnapshot(warm.root, warmBuild.buildId);
              const coldSnapshot = logicalCacheSnapshot(cold.root, coldBuild.buildId);
              expect(canonicalJson(warmSnapshot)).toBe(canonicalJson(coldSnapshot));
              assertCacheLandmarks(warmSnapshot);
              if (change === 'baseline' || change === 'missing body')
                expect(warmBuild.buildId).toBe(initial.buildId);
              else expect(warmBuild.buildId).not.toBe(initial.buildId);
              if (change === 'rules')
                expect(
                  warmSnapshot.artifacts.find((artifact) => artifact.relative_path === 'guide.md')
                    ?.authority,
                ).toBe(90);
              if (change === 'chunking')
                expect(warmSnapshot.manifest.counts.chunks).toBeGreaterThan(
                  before.manifest.counts.chunks,
                );
            } finally {
              actualParse.mockRestore();
            }
          });
        });
      });
    },
  );

  it('reports the actual uncached table work through the real CLI process', async () => {
    const sources = await mixedCacheSources();
    await withTempProject({ files: { 'lore.yaml': CACHE_CONFIG } }, async (project) => {
      writeCacheSources(project.root, sources);
      const binary = join(import.meta.dirname, '..', 'dist', 'entry.js');
      const runBuildProcess = (): BuildResult =>
        JSON.parse(
          execFileSync(process.execPath, [binary, '--cwd', project.root, 'build', '--json'], {
            encoding: 'utf8',
          }),
        ) as BuildResult;
      const cold = runBuildProcess();
      const warm = runBuildProcess();
      expect(cold).toMatchObject({ rebuiltArtifacts: 8, reusedArtifacts: 0 });
      expect(warm).toMatchObject({
        rebuiltArtifacts: 2,
        reusedArtifacts: 6,
        buildId: cold.buildId,
      });
      expect(warm.counts).toEqual(cold.counts);
      expect(warm.warnings).toBe(cold.warnings);
      const snapshot = logicalCacheSnapshot(project.root, warm.buildId);
      assertCacheLandmarks(snapshot);
      const guide = snapshot.artifacts.find((artifact) => artifact.relative_path === 'guide.md');
      const hash = String(guide?.object_hash);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      rmSync(
        project.path(
          `.lore/objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`,
        ),
      );
      const recovered = runBuildProcess();
      expect(recovered).toMatchObject({
        rebuiltArtifacts: 3,
        reusedArtifacts: 5,
        buildId: cold.buildId,
      });
      expect(canonicalJson(logicalCacheSnapshot(project.root, recovered.buildId))).toBe(
        canonicalJson(snapshot),
      );
    });
  });
});
