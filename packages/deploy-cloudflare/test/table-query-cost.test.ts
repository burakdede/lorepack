import { afterEach, describe, expect, it } from 'vitest';
import {
  createCloudflareWorkerFromBindings,
  hashRuntimeToken,
  type RateLimitLike,
  storeRuntimeTokenHash,
  tableQueryCaller,
} from '../src/index.js';
import worker from '../src/worker.js';
import {
  createProjectedWorkerRuntimeFixture,
  PROJECT,
  TABLE_ID,
} from './projected-runtime-fixture.js';

/**
 * What bounds the cost of a remote table query (#558).
 *
 * D1 cannot be interrupted before its own 30 second limit, and runs one query at a time per
 * database. The statement guard refuses the amplifiers it can see statically; the Worker's
 * per-caller rate limit bounds everything else. Both run here against the real projected
 * store over node:sqlite, standing in for D1.
 */

type Fixture = Awaited<ReturnType<typeof createProjectedWorkerRuntimeFixture>>;
let fixture: Fixture | null = null;

afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

async function open(): Promise<Fixture> {
  fixture = await createProjectedWorkerRuntimeFixture();
  return fixture;
}

async function query(fixtureValue: Fixture, sql: string): Promise<unknown> {
  return await fixtureValue.runtime.queryTable({ tableId: fixtureValue.knownTableId, sql });
}

const TEN = Array.from({ length: 10 }, (_, index) => `(${String(index)})`).join(', ');

describe('the remote statement guard, end to end', () => {
  it('refuses a cross join of literal rows over a table of three', async () => {
    const opened = await open();
    const described = await opened.runtime.describeTable(opened.knownTableId);
    // Seven ways of ten literal rows is 1e7 rows. Counted as the table's three rows each, it
    // was admitted and ran to completion.
    const sql = `WITH v(x) AS (VALUES ${TEN}) SELECT count(*) AS n FROM ${'abcdefg'
      .split('')
      .map((alias) => `v ${alias}`)
      .join(', ')} WHERE EXISTS (SELECT 1 FROM ${described.sqlName})`;
    await expect(query(opened, sql)).rejects.toMatchObject({ code: 'LORE_E_SQL_REJECTED' });
  });

  it('refuses a CTE that recurses without the RECURSIVE keyword', async () => {
    const opened = await open();
    await expect(
      query(
        opened,
        'WITH c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000000) SELECT count(*) AS n FROM c',
      ),
    ).rejects.toMatchObject({ code: 'LORE_E_SQL_REJECTED' });
  });

  it('refuses a printf width that makes one row cost a megabyte', async () => {
    const opened = await open();
    const described = await opened.runtime.describeTable(opened.knownTableId);
    const column = described.columns[0]?.sqlName ?? 'rowid';
    await expect(
      query(
        opened,
        `SELECT sum(length(printf('%.*c', 1000000, ${column}))) AS n FROM ${described.sqlName}`,
      ),
    ).rejects.toMatchObject({ code: 'LORE_E_SQL_REJECTED' });
  });
});

class CountingLimiter implements RateLimitLike {
  readonly keys: string[] = [];
  constructor(readonly allowed: number) {}

  async limit(options: { readonly key: string }): Promise<{ readonly success: boolean }> {
    this.keys.push(options.key);
    return {
      success: this.keys.filter((key) => key === options.key).length <= this.allowed,
    };
  }
}

function tableQueryRequest(sqlName: string, token = 'lore_rt_first'): Request {
  return new Request(`https://worker.example/v1/tables/${encodeURIComponent(TABLE_ID)}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sql: `SELECT count(*) AS n FROM ${sqlName}` }),
  });
}

describe('the Worker table query rate limit', () => {
  it('refuses a caller past its limit with a typed busy error, before D1 sees the query', async () => {
    const opened = await open();
    const described = await opened.runtime.describeTable(opened.knownTableId);
    const limiter = new CountingLimiter(2);
    const request = tableQueryRequest(described.sqlName);
    const app = createCloudflareWorkerFromBindings(
      {
        CATALOG_DB: opened.projection,
        TABLES_DB: opened.projection,
        OBJECTS: opened.bucket,
        PROJECT_ID: PROJECT,
        TABLE_QUERY_LIMITER: limiter,
      },
      { tableQueryCaller: await tableQueryCaller(request) },
    );

    expect((await app.fetch(request.clone())).status).toBe(200);
    expect((await app.fetch(request.clone())).status).toBe(200);
    const refused = await app.fetch(request.clone());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'LORE_E_BUSY' } });

    // Only table queries are counted.
    const search = await app.fetch(
      new Request('https://worker.example/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'rollback', limit: 5, includeArchived: false, debug: false }),
      }),
    );
    expect(search.status).toBe(200);
    expect(limiter.keys).toHaveLength(3);
    await app.close();
  });

  it('keys the limit on a hash of the credential, never the credential itself', async () => {
    const first = await tableQueryCaller(tableQueryRequest('t', 'lore_rt_first'));
    const again = await tableQueryCaller(tableQueryRequest('t', 'lore_rt_first'));
    const second = await tableQueryCaller(tableQueryRequest('t', 'lore_rt_second'));
    const access = await tableQueryCaller(
      new Request('https://worker.example/', { headers: { 'Cf-Access-Jwt-Assertion': 'jwt' } }),
    );
    expect(first).toBe(again);
    expect(new Set([first, second, access]).size).toBe(3);
    expect(first).not.toContain('lore_rt_first');
    expect(first).toMatch(/^table-query:[0-9a-f]{64}$/);
  });

  it('makes the deployed Worker refuse table queries when the binding is missing', async () => {
    const opened = await open();
    const described = await opened.runtime.describeTable(opened.knownTableId);
    const token = 'lore_rt_deployed_worker';
    await storeRuntimeTokenHash(
      opened.projection,
      await hashRuntimeToken(token),
      new Date().toISOString(),
    );
    const env = {
      CATALOG_DB: opened.projection,
      TABLES_DB: opened.projection,
      OBJECTS: opened.bucket,
      PROJECT_ID: PROJECT,
    };

    const unbound = await worker.fetch(tableQueryRequest(described.sqlName, token), env);
    expect(await unbound.json()).toMatchObject({
      error: { code: 'LORE_E_TARGET_NOT_CONFIGURED' },
    });

    const limiter = new CountingLimiter(1);
    const bound = { ...env, TABLE_QUERY_LIMITER: limiter };
    expect((await worker.fetch(tableQueryRequest(described.sqlName, token), bound)).status).toBe(
      200,
    );
    expect((await worker.fetch(tableQueryRequest(described.sqlName, token), bound)).status).toBe(
      429,
    );
    expect(limiter.keys[0]).toBe(await tableQueryCaller(tableQueryRequest('t', token)));
  });
});
