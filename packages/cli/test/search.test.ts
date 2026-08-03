import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ProgressBus, searchResultSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

const CORPUS = {
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release without recompiling anything.\n',
  'guides/onboarding.md': '# Onboarding\n\nNew engineers configure their laptop on day one.\n',
  'notes/meeting.txt': 'We discussed rollback safety and the deployment schedule.\n',
};

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

async function builtProject<T>(
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return project(CORPUS, async (root, lore) => {
    await build(root);
    return body(root, lore);
  });
}

describe('lore search', () => {
  it('returns located results with a highlighted excerpt', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', 'rollback']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('guides/deployment.md');
      expect(result.stdout).toContain('[Rollback]');
    });
  });

  it('shows the active build and the source state in the header', async () => {
    await builtProject(async (root, lore) => {
      expect((await lore(['search', 'rollback'])).stdout).toMatch(
        /Build lore_\w+ \(sources clean\)/,
      );

      writeFileSync(join(root, 'guides/onboarding.md'), '# Onboarding\n\nChanged.\n', 'utf8');
      expect((await lore(['search', 'rollback'])).stdout).toContain('sources dirty');
    });
  });

  it('gives every result a complete source locator', async () => {
    // Section 10.8: a result without provenance is a bug, not a style problem.
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout);
      expect(parsed.hits.length).toBeGreaterThan(0);
      for (const hit of parsed.hits) {
        expect(hit.locator.artifactId).toBeTruthy();
        expect(hit.locator.relativePath).toBeTruthy();
      }
    });
  });

  it('validates against the committed search-result schema', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'search', 'rollback'])).stdout);
      expect(searchResultSchema.safeParse(parsed).success).toBe(true);
    });
  });

  it('honours --limit', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'search', 'the', '--limit', '1'])).stdout);
      expect(parsed.hits).toHaveLength(1);
    });
  });

  it('rejects a limit outside the supported range', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', 'rollback', '--limit', '0']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('between 1 and 100');
    });
  });

  it('restricts by path glob and by file type', async () => {
    await builtProject(async (_root, lore) => {
      const byPath = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--path', 'guides/*'])).stdout,
      );
      expect(byPath.hits.length).toBeGreaterThan(0);
      for (const hit of byPath.hits) expect(hit.locator.relativePath).toContain('guides/');

      const byType = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--type', 'txt'])).stdout,
      );
      for (const hit of byType.hits) expect(hit.locator.relativePath.endsWith('.txt')).toBe(true);
    });
  });

  it('restricts to one document with --source, by path and by artifact id', async () => {
    await builtProject(async (_root, lore) => {
      const byPath = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--source', 'guides/deployment.md'])).stdout,
      );
      expect(byPath.hits.length).toBeGreaterThan(0);
      for (const hit of byPath.hits) {
        expect(hit.locator.relativePath).toBe('guides/deployment.md');
      }

      // The id from the answer works as well as the path a person typed, which is what
      // lets a follow-up question be built from the previous result.
      const id = byPath.hits[0].locator.artifactId;
      const byId = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--source', id])).stdout,
      );
      expect(byId.hits.map((hit: { chunkId: string }) => hit.chunkId)).toEqual(
        byPath.hits.map((hit: { chunkId: string }) => hit.chunkId),
      );

      // A document this project does not have is empty, never widened to a near match.
      const missing = JSON.parse(
        (await lore(['--json', 'search', 'rollback', '--source', 'guides/'])).stdout,
      );
      expect(missing.hits).toEqual([]);
    });
  });

  it.each([
    ['a bare quote', 'rollback"'],
    ['a wildcard', 'roll*'],
    ['a column filter', 'body:rollback'],
    ['an operator word', 'rollback NEAR deployment'],
    ['boolean syntax', 'rollback AND OR NOT'],
    ['a parenthesis', 'rollback)('],
    ['unicode', 'rollbäck 回滚'],
    ['a very long query', `rollback ${'x'.repeat(500)}`],
  ])('handles %s without a raw error', async (_label, query) => {
    // Every term is quoted, so FTS5 syntax is treated as text. A user can never produce a
    // parser error, and operator support would be a deliberate feature with its own
    // surface rather than an accident of quoting.
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', query]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('LORE_E');
    });
  });

  it('treats an empty query as no matches rather than an error', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', '   ']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No matches');
    });
  });

  it('says how many chunks were searched when nothing matched', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', 'zygomorphic']);
      expect(result.stdout).toContain('No matches');
      expect(result.stdout).toMatch(/Searched \d+ chunks/);
    });
  });

  it('tells the user to build first when there is no active build', async () => {
    await project(CORPUS, async (_root, lore) => {
      const result = await lore(['search', 'rollback']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore build');
    });
  });

  it('refuses to read a table outside the search allowlist', async () => {
    // The authorizer is defence in depth: even a query-construction bug cannot reach a
    // table the search surface was never meant to touch.
    await builtProject(async (root) => {
      const { openReadOnly, restrictToTables, SEARCH_TABLES } = await import(
        '@lorepack/backend-local'
      );
      const { readActiveBuild } = await import('../src/services/project.js');
      const active = readActiveBuild(join(root, '.lore'));
      const db = openReadOnly(
        join(root, '.lore', 'builds', String(active?.buildId), 'context.sqlite'),
      );
      try {
        restrictToTables(db, SEARCH_TABLES);
        expect(() => db.prepare('SELECT * FROM build_warnings').all()).toThrow();
        expect(() => db.prepare('SELECT id FROM chunks LIMIT 1').all()).not.toThrow();
      } finally {
        db.close();
      }
    });
  });
});

describe('what a search result shows a reader', () => {
  // #150. Raw BM25 is negative and near zero on a small corpus, so every hit printed
  // `(score -0.00)`: a number that discriminated nothing and read as an error to anyone
  // who does not know FTS5. A comparable relevance figure is #42's job.
  it('leads with the rank and the location, not an unusable number', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', 'rollback']);

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('score');
      expect(result.stdout).not.toContain('-0.00');
      expect(result.stdout).toMatch(/ 1\. \S+\.md:\d+/);
    });
  });

  it('shows the relevance score under --verbose, on a scale a reader can compare', async () => {
    // #42 replaced the raw BM25 with a bounded relevance score. The raw value is still
    // reachable, as `lexicalRaw` in the debug components, for anyone comparing engines.
    await builtProject(async (_root, lore) => {
      const result = await lore(['--verbose', 'search', 'rollback']);
      expect(result.stdout).toMatch(/relevance \d\.\d\d/);
    });
  });

  it('explains a page only when asked, and says what the number is not', async () => {
    await builtProject(async (_root, lore) => {
      const plain = await lore(['search', 'rollback']);
      const debug = await lore(['search', 'rollback', '--debug']);

      expect(plain.stdout).not.toContain('why:');
      expect(debug.stdout).toContain('why:');
      expect(debug.stdout).toContain('lexical');
      // Architecture 13.2: never imply a lexical score is a confidence or a truth score.
      expect(debug.stdout).toContain('not a confidence');
    });
  });

  it('keeps the raw score in JSON, which is the committed contract', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['--json', 'search', 'rollback']);
      const parsed = JSON.parse(result.stdout) as { hits: Array<{ score: number }> };
      expect(typeof parsed.hits[0]?.score).toBe('number');
    });
  });

  it('counts chunks in agreement with itself', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['search', 'rollback']);
      expect(result.stdout).not.toMatch(/\b1 chunks\b/);
    });
  });
});
