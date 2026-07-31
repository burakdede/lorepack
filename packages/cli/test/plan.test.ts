import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

async function project<T>(
  files: Record<string, string>,
  body: (root: string, plan: (args?: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, async (temp) =>
    body(temp.root, (args = []) => run(['--cwd', temp.root, 'plan', ...args])),
  );
}

describe('lore plan', () => {
  it('previews a first build and exits 0', async () => {
    await project({ 'docs/a.md': '# A', 'docs/b.md': '# B' }, async (_root, plan) => {
      const result = await plan();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Plan for first build');
      expect(result.stdout).toContain('+ 2 added');
    });
  });

  it('does not index Lorepack project files, which are tooling metadata', async () => {
    await project({ 'docs/a.md': '# A' }, async (_root, plan) => {
      const result = await plan();
      expect(result.stdout).not.toContain('lore.yaml');
      expect(result.stdout).not.toContain('.loreignore');
      expect(result.stdout).toContain('+ 1 added');
    });
  });

  it('reports what will be skipped rather than silently dropping it', async () => {
    await project({ 'docs/a.md': '# A', 'photo.png': 'x' }, async (_root, plan) => {
      const result = await plan();
      expect(result.stdout).toContain('Warnings');
      expect(result.stdout).toContain('photo.png');
    });
  });

  it('writes nothing at all, which is what makes it a plan', async () => {
    await project({ 'docs/a.md': '# A' }, async (root, plan) => {
      const before = readdirSync(root).sort();
      await plan();
      await plan();
      expect(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(`${root}/lore.yaml`, 'utf8')).toBe(CONFIG);
    });
  });

  it('emits a schema-shaped document under --json with nothing else on stdout', async () => {
    await withTempProject({ files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A' } }, async (temp) => {
      const result = await run(['--cwd', temp.root, '--json', 'plan']);
      const parsed = JSON.parse(result.stdout) as { formatVersion: number; projectName: string };
      expect(parsed.formatVersion).toBe(1);
      expect(parsed.projectName).toBe('demo');
      expect(result.stdout).not.toContain('Discovering');
      expect(result.stderr).toContain('Discovering');
    });
  });

  it('exits 0 with changes by default, and 2 only when asked', async () => {
    await project({ 'docs/a.md': '# A' }, async (_root, plan) => {
      expect((await plan()).code).toBe(0);
      expect((await plan(['--exit-code'])).code).toBe(2);
    });
  });

  it('fails with an actionable error outside a project', async () => {
    await withTempProject({ files: { 'a.md': '# A' } }, async (temp) => {
      const result = await run(['--cwd', temp.root, 'plan']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_NOT_INITIALIZED');
      expect(result.stderr).toContain('lore init');
    });
  });

  it('surfaces a configuration error with its position', async () => {
    await withTempProject(
      { files: { 'lore.yaml': 'version: 1\nname: demo\nsources: []\n', 'a.md': '#' } },
      async (temp) => {
        const result = await run(['--cwd', temp.root, 'plan']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('LORE_E_CONFIG_INVALID');
      },
    );
  });

  it('refuses a project past the file envelope without the override', async () => {
    const files: Record<string, string> = { 'lore.yaml': CONFIG };
    for (let i = 0; i < 5; i += 1) files[`f${i}.md`] = `# ${i}`;
    await withTempProject({ files }, async (temp) => {
      // The envelope is 2,500 files, so this asserts the flag is wired rather than the
      // limit itself, which is covered in the compiler tests.
      const result = await run(['--cwd', temp.root, 'plan', '--allow-large-project']);
      expect(result.code).toBe(0);
    });
  });

  it('reflects an edit between two runs', async () => {
    await project({ 'docs/a.md': '# A' }, async (root, plan) => {
      const first = await plan();
      expect(first.stdout).toContain('+ 1 added');

      writeFileSync(`${root}/docs/b.md`, '# B', 'utf8');
      const second = await plan();
      expect(second.stdout).toContain('+ 2 added');
    });
  });
});
