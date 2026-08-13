import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const EXAMPLES = join(ROOT, 'examples');

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('checked-in example projects', () => {
  it.each([
    ['product-research', { artifacts: 4, tables: 1 }],
    ['coding-project', { artifacts: 3, tables: 0 }],
  ])('builds %s with expected artifacts and tables', async (name, expected) => {
    const root = copyExample(name);
    const built = await run(['--cwd', root, 'build']);
    expect(built.code).toBe(0);

    const inspected = await run(['--cwd', root, 'inspect', 'build', '--json']);
    expect(inspected.code).toBe(0);
    const json = JSON.parse(inspected.stdout) as {
      counts: { artifacts: number; tables: number };
    };
    expect(json.counts.artifacts).toBe(expected.artifacts);
    expect(json.counts.tables).toBe(expected.tables);
  });

  it('exports a cited product-research task bundle', async () => {
    const root = copyExample('product-research');
    expect((await run(['--cwd', root, 'build'])).code).toBe(0);

    const exported = await run([
      '--cwd',
      root,
      'export',
      '--task',
      'What should the launch page say?',
    ]);

    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain('Git and Terraform');
    expect(exported.stdout).toContain('research/current/positioning.md');
  });
});

function copyExample(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `lore-example-${name}-`));
  roots.push(root);
  cpSync(join(EXAMPLES, name), root, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('.lore'),
  });
  expect(basename(root)).toContain(name);
  return root;
}
