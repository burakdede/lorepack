import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus, statusSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readStatus } from '../src/services/status.js';
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

function build(root: string) {
  return runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });
}

function status(root: string, now?: () => Date) {
  return readStatus({
    config: loadConfig({ cwd: root }),
    ...(now === undefined ? {} : { now }),
  });
}

describe('lore status', () => {
  it('tells an unbuilt project what to do, and exits 0', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const result = await lore(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No build yet');
      expect(result.stdout).toContain('lore build');

      expect((await status(root)).sourceState).toBe('unbuilt');
    });
  });

  it('reports a clean project after a build', async () => {
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root, lore) => {
      const built = await build(root);
      const result = await lore(['status']);

      expect(result.stdout).toContain(built.buildId.slice(0, 17));
      expect(result.stdout).toContain('Sources are clean');
      expect(result.stdout).toContain('content hash');

      const parsed = await status(root);
      expect(parsed.sourceState).toBe('clean');
      expect(parsed.remediation).toBeNull();
      expect(parsed.artifacts).toMatchObject({ total: 2, added: 0, changed: 0, removed: 0 });
    });
  });

  it.each([
    [
      'a modified file',
      (root: string) => writeFileSync(join(root, 'a.md'), '# A\n\nEdited.', 'utf8'),
      'changed',
    ],
    [
      'a new file',
      (root: string) => writeFileSync(join(root, 'c.md'), '# C\n\nNew.', 'utf8'),
      'added',
    ],
    ['a deleted file', (root: string) => rmSync(join(root, 'b.md')), 'removed'],
  ])('detects %s', async (_label, mutate, kind) => {
    await project({ 'a.md': '# A\n\nText.', 'b.md': '# B\n\nMore.' }, async (root) => {
      await build(root);
      mutate(root);

      const parsed = await status(root);
      expect(parsed.sourceState).toBe('dirty');
      expect(parsed.remediation).toBe('lore build');
      expect(parsed.changes.map((change) => change.change)).toContain(kind);
    });
  });

  it('decides dirtiness by content, not by modification time', async () => {
    // Section 12.3: an mtime can move without the content changing. Reporting that as
    // dirty would train users to ignore the answer.
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      await build(root);
      const path = join(root, 'a.md');
      const future = new Date(Date.now() + 60_000);
      writeFileSync(path, '# A\n\nText.', 'utf8');
      const { atime } = statSync(path);
      const { utimesSync } = await import('node:fs');
      utimesSync(path, atime, future);

      const parsed = await status(root);
      expect(parsed.sourceState).toBe('clean');
      expect(parsed.decidedBy).toBe('content-hash');
    });
  });

  it('lists changed paths grouped by type under --verbose only', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nEdited.', 'utf8');

      const plain = await lore(['status']);
      expect(plain.stdout).not.toContain('a.md');

      const verbose = await lore(['status', '--verbose']);
      expect(verbose.stdout).toContain('changed:');
      expect(verbose.stdout).toContain('a.md');
    });
  });

  it('reports the build age', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root) => {
      await build(root);
      const later = new Date(Date.now() + 3 * 3600_000);
      const parsed = await status(root, () => later);
      expect(parsed.buildAgeSeconds).toBeGreaterThanOrEqual(3 * 3600 - 5);
    });
  });

  it('validates against the committed status schema and includes the full build id', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      const built = await build(root);
      const result = await lore(['--json', 'status']);

      const parsed = JSON.parse(result.stdout);
      expect(statusSchema.safeParse(parsed).success).toBe(true);
      expect(parsed.activeBuildId).toBe(built.buildId);
      expect(result.stdout).not.toContain('Fingerprinting');
    });
  });

  it('counts the warnings the active build actually recorded', async () => {
    await project({ 'a.md': '# A\n\nText.', 'photo.png': 'x' }, async (root) => {
      await build(root);
      expect((await status(root)).warnings).toBeGreaterThan(0);
    });
  });

  it('exits 0 when dirty by default and 2 only with --exit-code', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      writeFileSync(join(root, 'a.md'), '# A\n\nEdited.', 'utf8');

      expect((await lore(['status'])).code).toBe(0);
      expect((await lore(['status', '--exit-code'])).code).toBe(2);
    });
  });

  it('exits 0 with --exit-code when the project is clean', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);
      expect((await lore(['status', '--exit-code'])).code).toBe(0);
    });
  });

  it('writes nothing, so asking about a project never changes it', async () => {
    await project({ 'a.md': '# A\n\nText.' }, async (root, lore) => {
      await build(root);

      const snapshot = (): string => [...walk(root)].sort().join('|');
      const before = snapshot();
      await lore(['status']);
      await lore(['status']);
      expect(snapshot()).toBe(before);
    });
  });
});

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield `${path}:${statSync(path).size}`;
  }
}
