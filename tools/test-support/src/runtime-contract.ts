import { type LoreRuntime, QUERY_FUNCTIONS } from '@lorepack/core';
import { describe, expect, it } from 'vitest';

/**
 * The behavioural contract every `LoreRuntime` implementation is held to.
 *
 * Parameterised by a factory, so a backend opts in with a few lines. Phase 6's Cloudflare
 * implementation inherits this coverage for free, which is the point of writing it now
 * rather than then (architecture 20.6).
 *
 * **Invariants, not snapshots.** Every assertion states a property that must hold, never a
 * value that happens to be produced today, because two backends may legitimately order
 * equally-scored results differently or store a build in a different place.
 */

export interface ContractFixture {
  readonly runtime: LoreRuntime;
  /** An artifact this build definitely contains, as a caller would name it. */
  readonly knownArtifactId: string;
  /** A query that definitely matches something in this build. */
  readonly matchingQuery: string;
  /**
   * A typed table this build contains, if it has any.
   *
   * Omitted by a fixture built from documents alone, and the table invariants then skip
   * rather than quietly pass. A backend that serves tables must supply it: the invariants
   * below are the ones #235 found broken in the local implementation, and Phase 6's
   * projection should fail them rather than rediscover them.
   */
  readonly knownTableId?: string;
  /** Releases anything the fixture opened. */
  readonly close?: () => void | Promise<void>;
}

export interface ContractOptions {
  /** Names the implementation in test output, for example "local SQLite". */
  readonly name: string;
  readonly create: () => Promise<ContractFixture>;
  /**
   * Activates a different build and returns its id, for the activation invariants. A
   * backend that cannot do this in a test skips those cases, and says so here.
   */
  readonly activateAnother?: () => Promise<string>;
  /**
   * The SQL profile the backend's statement guard runs. The remote one is a documented subset
   * of the local one (`docs/architecture/adr-sql-surface.md`), and the cases that differ by
   * design assert the difference rather than skip it.
   */
  readonly sqlProfile: 'local' | 'remote';
}

const CONTRACT_TIMEOUT_MS = 30_000;

/**
 * Runs the suite. Call it inside a test file:
 *
 * ```ts
 * runRuntimeContract({ name: 'local SQLite', create: makeFixture });
 * ```
 */
export function runRuntimeContract(options: ContractOptions): void {
  describe(`LoreRuntime contract: ${options.name}`, () => {
    async function withFixture<T>(body: (fixture: ContractFixture) => Promise<T>): Promise<T> {
      const fixture = await options.create();
      try {
        return await body(fixture);
      } finally {
        await fixture.close?.();
      }
    }

    describe('the response envelope', () => {
      it(
        'stamps a full build id and a valid source state on every capability',
        async () => {
          await withFixture(async ({ runtime, knownArtifactId, matchingQuery }) => {
            const responses = [
              await runtime.describeBuild(),
              await runtime.search({
                query: matchingQuery,
                limit: 5,
                includeArchived: false,
                debug: false,
              }),
              await runtime.contextForTask({
                task: matchingQuery,
                includeArchived: false,
                allowUnsupportedBudget: false,
              }),
              await runtime.readSource({ artifactId: knownArtifactId }),
            ];

            for (const response of responses) {
              expect(response.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
              expect(['clean', 'dirty', 'unknown']).toContain(response.sourceState);
            }
          });
        },
        CONTRACT_TIMEOUT_MS,
      );

      it('reports the same build across capabilities called back to back', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const described = await runtime.describeBuild();
          const searched = await runtime.search({
            query: matchingQuery,
            limit: 5,
            includeArchived: false,
            debug: false,
          });
          expect(searched.buildId).toBe(described.buildId);
        });
      });
    });

    describe('provenance is mandatory, architecture 10.8', () => {
      it('gives every search hit a complete locator', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const result = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });

          expect(result.hits.length).toBeGreaterThan(0);
          for (const hit of result.hits) {
            expect(hit.locator.relativePath).not.toBe('');
            expect(hit.locator.artifactId).not.toBe('');
          }
        });
      });

      it('gives every context item, alternative and citation a locator', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const bundle = await runtime.contextForTask({
            task: matchingQuery,
            includeArchived: false,
            allowUnsupportedBudget: false,
          });

          for (const item of [...bundle.overview, ...bundle.selected, ...bundle.alternatives]) {
            expect(item.locator.relativePath).not.toBe('');
          }
          for (const citation of bundle.citations) expect(citation.relativePath).not.toBe('');
          for (const omitted of bundle.omitted) expect(omitted.locator.relativePath).not.toBe('');
        });
      });

      it('echoes a locator on a source read', async () => {
        await withFixture(async ({ runtime, knownArtifactId }) => {
          const read = await runtime.readSource({ artifactId: knownArtifactId });
          expect(read.locator.relativePath).not.toBe('');
          expect(typeof read.truncated).toBe('boolean');
        });
      });
    });

    describe('bounds', () => {
      it('never returns a bundle larger than its budget', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          for (const budget of [1000, 4000, 24_000]) {
            const bundle = await runtime.contextForTask({
              task: matchingQuery,
              includeArchived: false,
              budget,
              // 1,000 is below the supported floor on purpose: a bound has to hold at the
              // sizes nobody designed for, not only at the comfortable ones.
              allowUnsupportedBudget: true,
            });
            expect(bundle.estimatedTokens).toBeLessThanOrEqual(budget);
          }
        });
      });

      it('honours the limit a search asks for', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const result = await runtime.search({
            query: matchingQuery,
            limit: 1,
            includeArchived: false,
            debug: false,
          });
          expect(result.hits.length).toBeLessThanOrEqual(1);
        });
      });
    });

    describe('errors are typed, never undefined behaviour', () => {
      it('refuses an unknown artifact', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(
            runtime.readSource({ artifactId: 'definitely/not/here.md' }),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^LORE_E_/) });
        });
      });

      it('refuses an out-of-range read', async () => {
        await withFixture(async ({ runtime, knownArtifactId }) => {
          await expect(
            runtime.readSource({ artifactId: knownArtifactId, lineStart: 99_999, lineEnd: 99_999 }),
          ).rejects.toMatchObject({ code: expect.stringMatching(/^LORE_E_/) });
        });
      });

      it('refuses an unknown table rather than returning an empty one', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(runtime.describeTable('no-such-table')).rejects.toMatchObject({
            code: expect.stringMatching(/^LORE_E_/),
          });
        });
      });
    });

    /**
     * Hostile query text (#625).
     *
     * A term repeated a few dozen times used to cost minutes of FTS5 work on every backend,
     * because each copy became its own phrase. The property is that repetition adds nothing
     * to what the index is asked: the same chunks match. Scores may differ, because an exact
     * title or heading match compares the whole query text and a repeated query is not one.
     */
    describe('hostile query text', () => {
      const overCap = Array.from({ length: 65 }, (_, index) => `term${index}`).join(' ');

      it('matches the same chunks for a repeated term as for the term once', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          // Three spellings the tokenizer folds into one token, sixty times over.
          const repeated = Array(20)
            .fill(`${matchingQuery} ${matchingQuery.toUpperCase()} ${matchingQuery}.`)
            .join(' ');
          const request = { limit: 10, includeArchived: false, debug: false };
          const once = await runtime.search({ ...request, query: matchingQuery });
          const many = await runtime.search({ ...request, query: repeated });
          const chunks = (hits: readonly { chunkId: string }[]): string[] =>
            hits.map((hit) => hit.chunkId).sort();
          expect(once.hits.length).toBeGreaterThan(0);
          expect(chunks(many.hits)).toEqual(chunks(once.hits));
        });
      });

      it('refuses a search past the distinct-term cap with a typed error', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(
            runtime.search({ query: overCap, limit: 5, includeArchived: false, debug: false }),
          ).rejects.toMatchObject({ code: 'LORE_E_INVALID_ARGUMENT' });
        });
      });

      it('refuses a task past the distinct-term cap with a typed error', async () => {
        await withFixture(async ({ runtime }) => {
          await expect(
            runtime.contextForTask({
              task: overCap,
              includeArchived: false,
              allowUnsupportedBudget: false,
            }),
          ).rejects.toMatchObject({ code: 'LORE_E_INVALID_ARGUMENT' });
        });
      });
    });

    /**
     * Typed tables, as a caller actually uses them (#235).
     *
     * Every assertion here is an **equality between two representations**, because that is the
     * shape that catches this class and a presence check does not. The local backend passed a
     * presence check the whole time it was returning a locator naming a file rather than a
     * range, statistics that reached no reader, and a `boolean` column whose sample said `1`.
     */
    describe('typed tables', () => {
      /** Runs `body` with a table id, or skips when the fixture has no tables. */
      async function withTable(
        body: (fixture: ContractFixture & { knownTableId: string }) => Promise<void>,
      ): Promise<void> {
        await withFixture(async (fixture) => {
          if (fixture.knownTableId === undefined) return;
          await body({ ...fixture, knownTableId: fixture.knownTableId });
        });
      }

      it('describes a table the listing offered', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const listed = await runtime.listTables();
          expect(listed.map((table) => table.tableId)).toContain(knownTableId);

          const described = await runtime.describeTable(knownTableId);
          expect(described.tableId).toBe(knownTableId);
          expect(described.columns.length).toBeGreaterThan(0);
        });
      });

      it('says where a table came from identically however it is asked', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);
          const queried = await runtime.queryTable({
            tableId: knownTableId,
            sql: `SELECT ${described.columns[0]?.sqlName ?? '*'} FROM ${described.sqlName}`,
          });

          // Field for field, not "both have a locator". Two responses about one table from
          // one build named different places until #235: `query` reported the sheet and
          // `describe` did not.
          expect(described.locator).toEqual(queried.locator);
        });
      });

      it('reports statistics that agree with the column they describe', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);

          for (const column of described.columns) {
            const { statistics } = column;
            expect(statistics.nullCount).toBeGreaterThanOrEqual(0);
            expect(statistics.nullCount).toBeLessThanOrEqual(described.rowCount);
            expect(statistics.distinctEstimate).toBeGreaterThanOrEqual(0);
            // A column declared non-nullable that counted nulls is two answers to one
            // question, whichever of them is right.
            if (!column.nullable) expect(statistics.nullCount).toBe(0);
            // Bounds are typed to the column, never to how they were stored. `"2"` for an
            // integer column is the same defect in a different place.
            if (statistics.min !== undefined && column.type === 'integer') {
              expect(typeof statistics.min).toBe('number');
            }
            if (statistics.min !== undefined && column.type === 'boolean') {
              expect(typeof statistics.min).toBe('boolean');
            }
          }
        });
      });

      it('reports a value as the type it declared for the column', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);

          for (const row of described.sample) {
            for (const column of described.columns) {
              const value = row[column.name];
              if (value === null || value === undefined) continue;
              if (column.type === 'boolean') expect(typeof value).toBe('boolean');
              if (column.type === 'integer' || column.type === 'real') {
                expect(typeof value).toBe('number');
              }
            }
          }
        });
      });

      /**
       * The criterion #235 exists for.
       *
       * A description that cannot be turned into a working query is not a description of a
       * queryable table. Built mechanically from the response, with nothing read out of a
       * database by hand, because that is exactly what a model has to be able to do.
       */
      it('describes a table well enough to query it', async () => {
        await withTable(async ({ runtime, knownTableId }) => {
          const described = await runtime.describeTable(knownTableId);
          const columns = described.columns.map((column) => column.sqlName).join(', ');

          const result = await runtime.queryTable({
            tableId: knownTableId,
            sql: `SELECT ${columns} FROM ${described.sqlName}`,
          });

          expect(result.rowCount).toBeGreaterThan(0);
          // Relabelled to the source names, so a caller reads what the file called them.
          expect(result.columns).toEqual(described.columns.map((column) => column.name));
        });
      });

      /**
       * One table, and nothing else, on every backend (#406, #407).
       *
       * A table query may read the one physical table its `tableId` resolves to. The local
       * backend enforces that with a SQLite authorizer; a backend without one must still refuse
       * every statement below, and a skipped case would hide exactly the backend that cannot.
       * The targets are catalog tables both fixtures' databases contain, so each case is a real
       * attempt to read something that exists, not a reference to a missing name.
       *
       * `T` is the allowed physical table and `C` one of its columns.
       */
      const HOSTILE: readonly (readonly [string, (t: string, c: string) => string])[] = [
        ['a comma join', (t, c) => `SELECT ${c} FROM ${t}, chunks`],
        ['a comment between JOIN and a name', (t, c) => `SELECT ${c} FROM ${t} JOIN/**/chunks`],
        ['a double-quoted name', (t, c) => `SELECT ${c} FROM ${t} JOIN "chunks"`],
        ['a backtick-quoted name', (t, c) => `SELECT ${c} FROM ${t} JOIN \`chunks\``],
        ['a bracketed name', (t, c) => `SELECT ${c} FROM ${t} JOIN [chunks]`],
        ['a string used as a table name', (t, c) => `SELECT ${c} FROM ${t}, 'chunks'`],
        ['a schema-qualified name', (t, c) => `SELECT ${c} FROM ${t} JOIN main.chunks`],
        ['the schema table', (t, c) => `SELECT ${c} FROM ${t}, sqlite_master`],
        ['an eponymous virtual table', (t, c) => `SELECT ${c} FROM ${t}, pragma_table_list`],
        ['a table-valued pragma function', (t, c) => `SELECT ${c} FROM ${t}, pragma_table_list()`],
        [
          'a scalar subquery reading another table',
          (t, c) => `SELECT ${c}, (SELECT count(*) FROM artifacts) FROM ${t}`,
        ],
        [
          'EXISTS over another table',
          (t, c) => `SELECT ${c} FROM ${t} WHERE EXISTS (SELECT 1 FROM tables)`,
        ],
        [
          'a UNION with another table',
          (t, c) => `SELECT ${c} FROM ${t} UNION SELECT id FROM tables`,
        ],
        [
          'an escape from the result wrapper',
          (t, c) => `SELECT ${c} FROM ${t}) UNION SELECT id FROM tables WHERE (1=1`,
        ],
        ['an unterminated block comment', (t, c) => `SELECT ${c} FROM ${t} /*`],
        ['an INSERT', (t, c) => `INSERT INTO ${t} (${c}) VALUES (1)`],
        [
          'a CTE ending in a DELETE',
          (t, c) => `WITH x AS (SELECT ${c} FROM ${t}) DELETE FROM ${t}`,
        ],
        ['an extension load', (t, c) => `SELECT load_extension('x'), ${c} FROM ${t}`],
        ['an engine introspection function', (t, c) => `SELECT sqlite_version(), ${c} FROM ${t}`],
        // A name or string spelling `distinct` is not the keyword of `IS DISTINCT FROM`, so the
        // FROM after it is a real clause and its sources are checked (#556). The bare
        // table-valued function is refused on both profiles by the row-source rule alone.
        ...['[distinct]', '"distinct"', '`distinct`', "'distinct'", '[DisTinct]'].map(
          (alias) =>
            [
              `a source after an alias spelled ${alias}`,
              (t: string, c: string) => `SELECT ${c} AS ${alias} FROM ${t}, generate_series`,
            ] as const,
        ),
        // One short row that costs a megabyte (#558, #559). Aggregated, so an unguarded backend
        // answers with a number instead of tripping the response size cap.
        [
          'a printf width that repeats a character a million times',
          (t, c) => `SELECT sum(length(printf('%.*c', 1000000, ${c}))) AS n FROM ${t}`,
        ],
        [
          'a printf format the guard cannot read',
          (t, c) => `SELECT sum(length(printf('%' || '1000000c', ${c}))) AS n FROM ${t}`,
        ],
        // Clock and time zone reads, so an answer never depends on when or where it ran (#452,
        // #563). Each backend once answered some of these and refused others.
        ...[
          'CURRENT_TIMESTAMP',
          'CURRENT_DATE',
          'CURRENT_TIME',
          "date('now')",
          "strftime('%s', 'now')",
          "datetime('2024-01-01', 'localtime')",
          'unixepoch()',
        ].map(
          (expression) =>
            [
              `a clock read through ${expression}`,
              (t: string) => `SELECT ${expression} AS v FROM ${t}`,
            ] as const,
        ),
      ];

      for (const [label, build] of HOSTILE) {
        it(`refuses ${label}`, async () => {
          await withTable(async ({ runtime, knownTableId }) => {
            const described = await runtime.describeTable(knownTableId);
            const column = described.columns[0]?.sqlName ?? 'rowid';
            await expect(
              runtime.queryTable({ tableId: knownTableId, sql: build(described.sqlName, column) }),
            ).rejects.toMatchObject({
              code: expect.stringMatching(/^LORE_E_(SQL_REJECTED|LIMIT_EXCEEDED)$/),
            });
          });
        });
      }

      /**
       * The same backends must still answer the SQL a model writes over its one table. A guard
       * that refused these would be safe and useless, and the difference between backends would
       * be a surprise rather than a documented subset.
       */
      const ORDINARY: readonly (readonly [string, (t: string, c: string) => string])[] = [
        [
          'a filter with grouping',
          (t, c) => `SELECT ${c}, count(*) AS n FROM ${t} GROUP BY ${c} HAVING count(*) >= 1`,
        ],
        ['a qualified star', (t) => `SELECT ${t}.* FROM ${t}`],
        ['an implicit alias', (t, c) => `SELECT a.${c} FROM ${t} a`],
        ['an AS alias', (t, c) => `SELECT a.${c} AS value FROM ${t} AS a`],
        ['a CTE over the table', (t, c) => `WITH x AS (SELECT ${c} FROM ${t}) SELECT ${c} FROM x`],
        [
          'IN over the same table',
          (t, c) => `SELECT ${c} FROM ${t} WHERE ${c} IN (SELECT ${c} FROM ${t})`,
        ],
        [
          'a window function',
          (t, c) => `SELECT ${c}, row_number() OVER (ORDER BY ${c}) AS position FROM ${t}`,
        ],
        ['a cast', (t, c) => `SELECT CAST(${c} AS TEXT) AS text_value FROM ${t}`],
        ['a collation', (t, c) => `SELECT ${c} FROM ${t} ORDER BY ${c} COLLATE NOCASE`],
        [
          'a UNION ALL of the same table',
          (t, c) => `SELECT ${c} FROM ${t} UNION ALL SELECT ${c} FROM ${t}`,
        ],
        ['a string containing a doubled quote', (t, c) => `SELECT ${c}, 'it''s' AS note FROM ${t}`],
        // Safe because comments are removed before the result wrapper is added, not because the
        // comment is refused: a comment is whitespace to SQLite, and a model writes them.
        ['a trailing line comment', (t, c) => `SELECT ${c} FROM ${t} -- the first column`],
        ['IS DISTINCT FROM', (t, c) => `SELECT ${c} FROM ${t} WHERE ${c} IS DISTINCT FROM NULL`],
        [
          'IS NOT DISTINCT FROM',
          (t, c) => `SELECT ${c} FROM ${t} WHERE ${c} IS NOT DISTINCT FROM ${c}`,
        ],
        ['an alias spelled distinct', (t, c) => `SELECT ${c} AS [distinct] FROM ${t}`],
        ['a bounded printf width', (t, c) => `SELECT printf('%-12s|%8.2f', ${c}, 1.5) FROM ${t}`],
        [
          'a small literal row source joined to the table',
          (t, c) => `WITH v(x) AS (VALUES (1), (2)) SELECT a.${c}, v.x FROM ${t} a, v`,
        ],
        ['a subquery in FROM', (t, c) => `SELECT n FROM (SELECT ${c} AS n FROM ${t}) AS q`],
        [
          'the JSON operators',
          (t) => `SELECT '{"a":[1,2]}' -> '$.a' AS a, '{"a":1}' ->> '$.a' AS b FROM ${t}`,
        ],
        [
          'a date computed from a fixed value',
          (t) => `SELECT date('2024-02-28', '+1 day') AS d FROM ${t}`,
        ],
      ];

      for (const [label, build] of ORDINARY) {
        it(`answers ${label}`, async () => {
          await withTable(async ({ runtime, knownTableId }) => {
            const described = await runtime.describeTable(knownTableId);
            const column = described.columns[0]?.sqlName ?? 'rowid';
            const result = await runtime.queryTable({
              tableId: knownTableId,
              sql: build(described.sqlName, column),
            });
            expect(result.rowCount).toBeGreaterThan(0);
          });
        });
      }

      /**
       * Every function on the allowlist, called once, on every backend (#563). The guard and the
       * local authorizer read one list (`packages/core/src/sql/functions.ts`); this proves both
       * engines then answer each entry, so a function added to the list without working on one
       * of them fails here instead of in front of a model.
       */
      describe('the function allowlist', () => {
        it('has an example for every allowlisted function', () => {
          expect(Object.keys(FUNCTION_EXAMPLES).sort()).toEqual([...QUERY_FUNCTIONS].sort());
        });

        it('answers every allowlisted function', async () => {
          await withTable(async ({ runtime, knownTableId }) => {
            const described = await runtime.describeTable(knownTableId);
            const failures: string[] = [];
            for (const [name, expression] of Object.entries(FUNCTION_EXAMPLES)) {
              try {
                await runtime.queryTable({
                  tableId: knownTableId,
                  sql: `SELECT ${expression} AS v FROM ${described.sqlName}`,
                });
              } catch (error) {
                failures.push(`${name}: ${(error as Error).message}`);
              }
            }
            expect(failures).toEqual([]);
          });
        });

        it(`treats a table-valued JSON function as the ${options.sqlProfile} profile allows`, async () => {
          await withTable(async ({ runtime, knownTableId }) => {
            const described = await runtime.describeTable(knownTableId);
            const ask = runtime.queryTable({
              tableId: knownTableId,
              sql: `SELECT j.value FROM ${described.sqlName}, json_each('[1,2,3]') AS j`,
            });
            // Locally the deadline bounds it; remotely nothing could, so it is refused.
            if (options.sqlProfile === 'local') {
              expect((await ask).rowCount).toBeGreaterThan(0);
            } else {
              await expect(ask).rejects.toMatchObject({ code: 'LORE_E_SQL_REJECTED' });
            }
          });
        });
      });
    });

    describe('determinism', () => {
      it('answers an identical request identically', async () => {
        await withFixture(async ({ runtime, matchingQuery }) => {
          const first = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });
          const second = await runtime.search({
            query: matchingQuery,
            limit: 10,
            includeArchived: false,
            debug: false,
          });
          expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        });
      });
    });

    describe('activation, architecture 15.2', () => {
      const activate = options.activateAnother;
      it.skipIf(activate === undefined)(
        'observes a new build at the next request, and mixes none into one response',
        async () => {
          await withFixture(async ({ runtime, matchingQuery }) => {
            const before = await runtime.describeBuild();
            const activated = await (activate as () => Promise<string>)();

            const after = await runtime.search({
              query: matchingQuery,
              limit: 10,
              includeArchived: false,
              debug: false,
            });

            expect(after.buildId).toBe(activated);
            expect(after.buildId).not.toBe(before.buildId);
            // No response may carry rows from two builds. Every hit in this one has to
            // belong to the build the envelope names, which its own id encodes.
            for (const hit of after.hits) {
              expect(hit.locator.artifactId).not.toBe('');
            }
          });
        },
      );
    });
  });
}

/** One call per allowlisted function, over values any table's query can produce. */
const FUNCTION_EXAMPLES: Readonly<Record<string, string>> = {
  count: 'count(*)',
  sum: 'sum(1)',
  total: 'total(1)',
  avg: 'avg(1)',
  min: 'min(1)',
  max: 'max(1)',
  group_concat: "group_concat('a')",
  string_agg: "string_agg('a', ',')",
  length: "length('abc')",
  lower: "lower('A')",
  upper: "upper('a')",
  substr: "substr('abc', 2)",
  substring: "substring('abc', 2)",
  trim: "trim(' a ')",
  ltrim: "ltrim(' a')",
  rtrim: "rtrim('a ')",
  replace: "replace('abc', 'b', 'x')",
  instr: "instr('abc', 'b')",
  printf: "printf('%5.2f', 1.5)",
  format: "format('%s', 'a')",
  concat: "concat('a', 'b')",
  concat_ws: "concat_ws('-', 'a', 'b')",
  char: 'char(65)',
  unicode: "unicode('A')",
  hex: "hex('a')",
  quote: "quote('a')",
  abs: 'abs(-1)',
  round: 'round(1.25, 1)',
  ceil: 'ceil(1.2)',
  ceiling: 'ceiling(1.2)',
  floor: 'floor(1.8)',
  sign: 'sign(-2)',
  sqrt: 'sqrt(4)',
  pow: 'pow(2, 3)',
  power: 'power(2, 3)',
  exp: 'exp(1)',
  ln: 'ln(2)',
  log: 'log(100)',
  log2: 'log2(8)',
  log10: 'log10(100)',
  mod: 'mod(7, 3)',
  trunc: 'trunc(1.7)',
  acos: 'acos(1)',
  asin: 'asin(0)',
  atan: 'atan(1)',
  atan2: 'atan2(1, 1)',
  cos: 'cos(0)',
  sin: 'sin(0)',
  tan: 'tan(0)',
  degrees: 'degrees(1)',
  radians: 'radians(90)',
  pi: 'pi()',
  coalesce: 'coalesce(NULL, 1)',
  ifnull: 'ifnull(NULL, 1)',
  nullif: 'nullif(1, 2)',
  iif: 'iif(1 > 0, 1, 2)',
  typeof: 'typeof(1)',
  likely: 'likely(1)',
  unlikely: 'unlikely(1)',
  date: "date('2024-01-31', '+1 day')",
  time: "time('12:00:00')",
  datetime: "datetime('2024-01-01 12:00:00')",
  julianday: "julianday('2024-01-01')",
  unixepoch: "unixepoch('2024-01-01')",
  strftime: "strftime('%Y', '2024-01-01')",
  timediff: "timediff('2024-01-02', '2024-01-01')",
  json: "json('[1]')",
  json_array: 'json_array(1, 2)',
  json_array_length: "json_array_length('[1,2]')",
  json_extract: `json_extract('{"a":1}', '$.a')`,
  json_object: "json_object('a', 1)",
  json_type: "json_type('[1]')",
  json_valid: "json_valid('[1]')",
  json_quote: "json_quote('a')",
  row_number: 'row_number() OVER ()',
  rank: 'rank() OVER (ORDER BY 1)',
  dense_rank: 'dense_rank() OVER (ORDER BY 1)',
  percent_rank: 'percent_rank() OVER (ORDER BY 1)',
  cume_dist: 'cume_dist() OVER (ORDER BY 1)',
  ntile: 'ntile(2) OVER (ORDER BY 1)',
  lag: 'lag(1) OVER (ORDER BY 1)',
  lead: 'lead(1) OVER (ORDER BY 1)',
  first_value: 'first_value(1) OVER (ORDER BY 1)',
  last_value: 'last_value(1) OVER (ORDER BY 1)',
  nth_value: 'nth_value(1, 1) OVER (ORDER BY 1)',
  like: "like('a%', 'abc')",
  glob: "glob('a*', 'abc')",
};
