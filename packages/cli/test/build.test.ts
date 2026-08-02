import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectLock } from '@lorepack/backend-local';
import { buildManifestSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
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

describe('lore build', () => {
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

describe('lore build command', () => {
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
