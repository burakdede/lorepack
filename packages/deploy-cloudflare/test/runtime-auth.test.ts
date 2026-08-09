import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeTokenAuthorizer,
  hashRuntimeToken,
  hasRuntimeToken,
  type RuntimeAuthDatabaseLike,
  type RuntimeAuthStatementLike,
  revokeRuntimeTokens,
  storeRuntimeTokenHash,
} from '../src/runtime-auth.js';

class SqliteRuntimeStatement implements RuntimeAuthStatementLike {
  readonly #db: DatabaseSync;
  readonly #query: string;
  #bindings: readonly unknown[] = [];

  constructor(db: DatabaseSync, query: string) {
    this.#db = db;
    this.#query = query;
  }

  bind(...values: unknown[]): RuntimeAuthStatementLike {
    this.#bindings = values;
    return this;
  }

  async run<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }> {
    const statement = this.#db.prepare(this.#query);
    if (this.#query.trim().toLowerCase().startsWith('select')) {
      return { results: statement.all(...this.#bindings) as readonly T[] };
    }
    statement.run(...this.#bindings);
    return {};
  }
}

class SqliteRuntimeDatabase implements RuntimeAuthDatabaseLike {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(query: string): RuntimeAuthStatementLike {
    return new SqliteRuntimeStatement(this.#db, query);
  }
}

const databases: DatabaseSync[] = [];

function openRuntimeDatabase(): {
  readonly db: DatabaseSync;
  readonly auth: SqliteRuntimeDatabase;
} {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return { db, auth: new SqliteRuntimeDatabase(db) };
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

describe('runtime token auth, issue 90', () => {
  it('stores only the hash and authorizes the matching bearer token', async () => {
    const { db, auth } = openRuntimeDatabase();
    const token = 'lore_rt_test_token';

    await storeRuntimeTokenHash(auth, await hashRuntimeToken(token), '2026-08-09T10:00:00.000Z');

    expect(await hasRuntimeToken(auth)).toBe(true);
    const rows = db
      .prepare('SELECT token_hash, created_at FROM runtime_tokens ORDER BY token_hash')
      .all() as Array<{ token_hash: string; created_at: string }>;
    expect(rows).toEqual([
      {
        token_hash: await hashRuntimeToken(token),
        created_at: '2026-08-09T10:00:00.000Z',
      },
    ]);
    expect(rows[0]?.token_hash).not.toContain(token);

    const authorize = createRuntimeTokenAuthorizer(auth);
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${token}`,
      }),
    ).toBe(true);
  });

  it('rejects missing or invalid bearer tokens with one non-enumerating message', async () => {
    const { auth } = openRuntimeDatabase();
    const token = 'lore_rt_test_token';
    await storeRuntimeTokenHash(auth, await hashRuntimeToken(token), '2026-08-09T10:00:00.000Z');
    const authorize = createRuntimeTokenAuthorizer(auth);

    expect(await authorize({ method: 'GET', path: '/v1/build' })).toBe(
      'This token is not valid for this build.',
    );
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        authorization: 'Bearer wrong',
      }),
    ).toBe('This token is not valid for this build.');
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        authorization: 'Basic abc',
      }),
    ).toBe('This token is not valid for this build.');
  });

  it('rotates by replacement and revokes by deletion', async () => {
    const { db, auth } = openRuntimeDatabase();
    const first = await hashRuntimeToken('lore_rt_first');
    const second = await hashRuntimeToken('lore_rt_second');

    await storeRuntimeTokenHash(auth, first, '2026-08-09T10:00:00.000Z');
    await storeRuntimeTokenHash(auth, second, '2026-08-09T10:05:00.000Z');

    const hashes = db
      .prepare('SELECT token_hash FROM runtime_tokens ORDER BY token_hash')
      .all() as Array<{ token_hash: string }>;
    expect(hashes).toEqual([{ token_hash: second }]);

    expect(await revokeRuntimeTokens(auth)).toBe(1);
    expect(await hasRuntimeToken(auth)).toBe(false);
  });
});
