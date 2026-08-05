import { tmpdir } from 'node:os';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createApiApp, createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * Hostile input against the **assembled** product (#83, architecture section 20.9).
 *
 * Every control asserted here already has a unit test: the SQL validator has its own suite, the
 * ZIP reader refuses a bomb, the XML reader refuses a DOCTYPE, path canonicalization has its
 * own. What none of those prove is that the control is **reached** by a request arriving at the
 * real API over a real build. A validator nobody calls passes every test it has.
 *
 * So this builds a genuine project, opens the genuine ports, and sends the genuine requests. It
 * is deliberately about the boundary rather than about the algorithms behind it.
 */

const CONFIG = 'version: 1\nname: guarded\nsources:\n  - .\n';

const PRICING = ['sku,qty', 'A-1,5', 'A-2,2', ''].join('\n');

async function withServedProject<T>(
  body: (context: {
    app: ReturnType<typeof createApiApp>;
    tableId: string;
    /** This machine's project root, which no response may ever disclose. */
    root: string;
  }) => Promise<T>,
): Promise<T> {
  return withTempProject(
    {
      files: {
        'lore.yaml': CONFIG,
        'docs/runbook.md': '# Runbook\n\n## Rolling back\n\nActivation is a pointer change.\n',
        'data/pricing.csv': PRICING,
      },
    },
    async (temp) => {
      await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
      const backend = createLocalRuntimeBackend({ projectRoot: temp.root });
      try {
        const runtime = createRuntime(backend);
        const current = await backend.provider.acquire();
        const buildId = current.buildId;
        current.release();

        const app = createApiApp({
          runtime,
          currentBuild: async () => ({ buildId, generation: 1 }),
          freshness: async () => 'clean',
        });
        return await body({ app, tableId: 'guarded:data/pricing.csv#table', root: temp.root });
      } finally {
        backend.close();
      }
    },
  );
}

/** The generated names a query must use, taken from the description rather than guessed. */
async function namesFor(
  app: ReturnType<typeof createApiApp>,
  tableId: string,
): Promise<{ table: string; column: string }> {
  const response = await app.request(`/v1/tables/${encodeURIComponent(tableId)}`);
  const described = (await response.json()) as {
    sqlName: string;
    columns: { sqlName: string }[];
  };
  return { table: described.sqlName, column: described.columns[0]?.sqlName ?? '' };
}

const query = (app: ReturnType<typeof createApiApp>, tableId: string, sql: string) =>
  app.request(`/v1/tables/${encodeURIComponent(tableId)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tableId, sql }),
  });

describe('a source read cannot escape the build', () => {
  /**
   * Every shape of "somewhere else" in one table.
   *
   * The point is not that any single one of these is clever. It is that the read resolves an
   * artifact **identifier against the catalog** rather than joining a caller's string onto a
   * path, so none of them is a path at all and the whole class is inert by construction.
   */
  const escapes = [
    ['a relative traversal', '../../../etc/passwd'],
    ['an encoded traversal', '..%2f..%2fetc%2fpasswd'],
    ['a POSIX absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\win.ini'],
    ['a UNC path', '\\\\server\\share\\secret'],
    ['a null byte suffix', 'docs/runbook.md\u0000.txt'],
    ['a path inside the build itself', '.lore/state.sqlite'],
  ] as const;

  for (const [what, artifactId] of escapes) {
    it(`refuses ${what}`, async () => {
      await withServedProject(async ({ app, root }) => {
        const response = await app.request(`/v1/sources/${encodeURIComponent(artifactId)}`);
        const body = (await response.json()) as { error?: { code: string; message: string } };
        const serialized = JSON.stringify(body);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(body.error?.code).toMatch(/^LORE_E_/);
        // **Nothing about this machine** reaches the caller. Echoing back the identifier the
        // caller themselves sent is fine and useful, so the assertion is specifically that no
        // real location on this machine appears: not the project root, not a directory beside
        // it, not the temp directory the build lives in.
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain(tmpdir());
      });
    });
  }

  it('still answers a legitimate read, so the guard is not simply refusing everything', async () => {
    await withServedProject(async ({ app }) => {
      const response = await app.request('/v1/sources/guarded%3Adocs%2Frunbook.md');
      const body = (await response.json()) as { text: string; locator: { relativePath: string } };

      expect(response.status).toBe(200);
      expect(body.locator.relativePath).toBe('docs/runbook.md');
      expect(body.text).toContain('pointer change');
    });
  });
});

describe('the SQL surface refuses everything but one read of one table', () => {
  /**
   * Each case names **which rule** must refuse it, not merely that something did.
   *
   * That distinction is the difference between a suite that catches a regression and one that
   * cannot. Written first without it, this suite passed with the multi-statement tokenizer
   * disabled outright, because the authorizer caught the second statement too. Defence in
   * depth is why that is comfortable and also why an undifferentiated assertion is useless:
   * the outer layer hides the inner one failing.
   */
  const rejected = [
    ['a write', 'DELETE FROM %TABLE%', /Only SELECT is allowed/i],
    ['an update', 'UPDATE %TABLE% SET %COLUMN% = 1', /Only SELECT is allowed/i],
    ['a schema change', 'DROP TABLE %TABLE%', /Only SELECT is allowed/i],
    ['a second statement', 'SELECT 1; DROP TABLE %TABLE%', /Only one statement/i],
    [
      'a second statement hidden by a comment',
      'SELECT 1 -- x\n; DROP TABLE %TABLE%',
      /Only one statement/i,
    ],
    ['the build catalog', 'SELECT * FROM tables', /outside the table it was asked about/i],
    ['the migration record', 'SELECT * FROM schema_migrations', /outside the table/i],
    ['the SQLite schema', 'SELECT name FROM sqlite_schema', /outside the table/i],
    ['a pragma function', 'SELECT * FROM pragma_table_list', /outside the table/i],
    // Refused because the function **does not exist**, not because an allowlist filtered it:
    // `node:sqlite` is built without the CLI's filesystem functions, so there is nothing to
    // permit or deny. Worth pinning as its own rule rather than folding into the authorizer's,
    // because if a future SQLite build ever gained them this expectation would change and the
    // authorizer would have to be the thing that stops them.
    ['a file read', "SELECT readfile('/etc/passwd')", /no such function/i],
    ['a file write', "SELECT writefile('/tmp/x', 'y')", /no such function/i],
    ['an attach', "SELECT 1; ATTACH DATABASE '/tmp/x.db' AS x", /Only one statement/i],
    ['a load_extension', "SELECT load_extension('x')", /outside the table/i],
  ] as const;

  for (const [what, template, rule] of rejected) {
    it(`refuses ${what}, by the rule that covers it`, async () => {
      await withServedProject(async ({ app, tableId, root }) => {
        const names = await namesFor(app, tableId);
        const sql = template.replace(/%TABLE%/g, names.table).replace(/%COLUMN%/g, names.column);

        const response = await query(app, tableId, sql);
        const body = (await response.json()) as { error?: { code: string; message: string } };

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(body.error?.code).toBe('LORE_E_SQL_REJECTED');
        expect(body.error?.message).toMatch(rule);
        // And nothing about the machine. SQLite words a denial as
        // `access to t_x.c_0_y is prohibited`, which names something the caller was not
        // allowed to see, so the message is replaced rather than wrapped.
        expect(JSON.stringify(body)).not.toMatch(/prohibited/i);
        expect(JSON.stringify(body)).not.toContain(root);
      });
    });
  }

  it('runs the one query it is for, so the surface is not simply closed', async () => {
    await withServedProject(async ({ app, tableId }) => {
      const names = await namesFor(app, tableId);
      const response = await query(app, tableId, `SELECT ${names.column} FROM ${names.table}`);
      const body = (await response.json()) as { rowCount: number };

      expect(response.status).toBe(200);
      expect(body.rowCount).toBe(2);
    });
  });
});

describe('a request cannot be made too large to refuse', () => {
  it('refuses an oversized statement at the boundary, naming the field', async () => {
    await withServedProject(async ({ app, tableId }) => {
      // Past the 100,000-character cap the request schema declares. Refused by the schema
      // before it reaches a validator, a process or a database.
      const response = await query(app, tableId, `SELECT '${'a'.repeat(200_000)}'`);
      const body = (await response.json()) as { error?: { code: string; subject?: string } };

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.error?.code).toBe('LORE_E_INVALID_ARGUMENT');
      expect(body.error?.subject).toBe('sql');
    });
  });

  it('refuses a body that is not JSON at all', async () => {
    await withServedProject(async ({ app, tableId }) => {
      const response = await app.request(`/v1/tables/${encodeURIComponent(tableId)}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json {{{',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(((await response.json()) as { error?: { code: string } }).error?.code).toMatch(
        /^LORE_E_/,
      );
    });
  });
});

describe('the served surface writes nothing', () => {
  /**
   * The invariant behind invariant 10, checked at the assembled boundary.
   *
   * `ApiOptions.localActions` is not supplied here, which is the shape a deployed runtime has.
   * Every mutating route must therefore be absent rather than merely guarded, because a guard
   * that is reachable is a guard that can be wrong.
   */
  const mutations = [
    ['POST', '/v1/activate'],
    ['POST', '/v1/build'],
    ['POST', '/v1/rollback'],
    ['POST', '/v1/pack'],
    ['DELETE', '/v1/builds/lore_x'],
  ] as const;

  for (const [method, path] of mutations) {
    it(`has no ${method} ${path}`, async () => {
      await withServedProject(async ({ app }) => {
        const response = await app.request(path, { method });
        // A typed 404 in the same shape as every other failure, so a client has one error
        // format rather than two.
        expect(response.status).toBe(404);
      });
    });
  }
});
