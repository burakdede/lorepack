import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A query engine missing from an install, reported without the install's path (#639).
 *
 * The published CLI once shipped without the query child, and the error named the absolute
 * path where it looked. That error reaches REST and MCP callers. The compiled module is copied
 * to a layout where neither the sibling nor the package fallback exists, which is what an
 * install with the child left out looks like to `childEntry()`.
 */

const PACKAGE = join(import.meta.dirname, '..');
const COMPILED = join(PACKAGE, 'dist', 'sql', 'execute.js');

let stray: string;
let moved: string;

beforeAll(() => {
  // Inside this package's `dist/`, so `@lorepack/core` still resolves from its `node_modules`.
  stray = mkdtempSync(join(PACKAGE, 'dist', '.missing-child-'));
  mkdirSync(join(stray, 'layout', 'sql'), { recursive: true });
  moved = join(stray, 'layout', 'sql', 'execute.js');
  copyFileSync(COMPILED, moved);
  // The source map too, or the test runner reports a missing map on every run.
  if (existsSync(`${COMPILED}.map`)) copyFileSync(`${COMPILED}.map`, `${moved}.map`);
});

afterAll(() => {
  rmSync(stray, { recursive: true, force: true });
});

describe('a missing query engine', () => {
  it('fails as LORE_E_INTERNAL naming the file, never where the install lives', async () => {
    const { executeQuery } = (await import(
      pathToFileURL(moved).href
    )) as typeof import('../src/sql/execute.js');

    const failure = await executeQuery({
      databasePath: join(stray, 'absent.sqlite'),
      allowedTables: [],
      sql: 'SELECT 1',
    }).then(
      () => undefined,
      (error: unknown) => error as { code: string; subject?: string; message: string },
    );

    expect(failure?.code).toBe('LORE_E_INTERNAL');
    expect(failure?.subject).toBe('query-child.js');
    const rendered = JSON.stringify(failure);
    expect(rendered).not.toContain(PACKAGE);
    expect(rendered).not.toContain(JSON.stringify(PACKAGE).slice(1, -1));
  });
});
