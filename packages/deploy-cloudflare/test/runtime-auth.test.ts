import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeTokenAuthorizer,
  hashRuntimeToken,
  hasRuntimeToken,
  listRuntimeTokens,
  RUNTIME_TOKEN_OVERLAP_MS,
  RUNTIME_TOKEN_PREFIX,
  type RuntimeAuthDatabaseLike,
  type RuntimeAuthStatementLike,
  revokeRuntimeTokens,
  rotateRuntimeTokenHash,
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
    const token = `${RUNTIME_TOKEN_PREFIX}test_token`;

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
    const token = `${RUNTIME_TOKEN_PREFIX}test_token`;
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

  it('rejects a deployment credential even if its hash is stored remotely', async () => {
    const { auth } = openRuntimeDatabase();
    const deploymentCredential = 'cf_api_token_for_deploy';
    await storeRuntimeTokenHash(
      auth,
      await hashRuntimeToken(deploymentCredential),
      '2026-08-09T10:00:00.000Z',
    );

    const authorize = createRuntimeTokenAuthorizer(auth);
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${deploymentCredential}`,
      }),
    ).toBe('This token is not valid for this build.');
  });

  // #562: a second rotation moved the first token's expiry later, so a token rotated out
  // after a suspected leak outlived its documented 10 minute overlap.
  it('never moves an expiry later when tokens are rotated twice', async () => {
    const { auth } = openRuntimeDatabase();
    const tokenA = `${RUNTIME_TOKEN_PREFIX}a`;
    const tokenB = `${RUNTIME_TOKEN_PREFIX}b`;
    const tokenC = `${RUNTIME_TOKEN_PREFIX}c`;
    const overlapFrom = (at: string) =>
      new Date(Date.parse(at) + RUNTIME_TOKEN_OVERLAP_MS).toISOString();

    await storeRuntimeTokenHash(auth, await hashRuntimeToken(tokenA), '2026-08-09T00:00:00.000Z');
    await rotateRuntimeTokenHash(
      auth,
      await hashRuntimeToken(tokenB),
      '2026-08-09T00:00:00.000Z',
      overlapFrom('2026-08-09T00:00:00.000Z'),
    );
    await rotateRuntimeTokenHash(
      auth,
      await hashRuntimeToken(tokenC),
      '2026-08-09T00:09:00.000Z',
      overlapFrom('2026-08-09T00:09:00.000Z'),
    );

    const expiries = new Map(
      (await listRuntimeTokens(auth)).map((row) => [row.tokenHash, row.expiresAt]),
    );
    expect(expiries.get(await hashRuntimeToken(tokenA))).toBe('2026-08-09T00:10:00.000Z');
    expect(expiries.get(await hashRuntimeToken(tokenB))).toBe('2026-08-09T00:19:00.000Z');
    expect(expiries.get(await hashRuntimeToken(tokenC))).toBeNull();

    const at = (now: string) => createRuntimeTokenAuthorizer(auth, () => now);
    const request = (token: string) => ({
      method: 'GET',
      path: '/v1/build',
      authorization: `Bearer ${token}`,
    });
    expect(await at('2026-08-09T00:15:00.000Z')(request(tokenA))).toBe(
      'This token is not valid for this build.',
    );
    expect(await at('2026-08-09T00:15:00.000Z')(request(tokenB))).toBe(true);
    expect(await at('2026-08-09T00:15:00.000Z')(request(tokenC))).toBe(true);
  });

  it('keeps the previous token valid through the overlap window, then expires it', async () => {
    const { db, auth } = openRuntimeDatabase();
    const firstToken = `${RUNTIME_TOKEN_PREFIX}first`;
    const secondToken = `${RUNTIME_TOKEN_PREFIX}second`;
    const overlapEndsAt = new Date(
      Date.parse('2026-08-09T10:05:00.000Z') + RUNTIME_TOKEN_OVERLAP_MS,
    ).toISOString();

    await storeRuntimeTokenHash(
      auth,
      await hashRuntimeToken(firstToken),
      '2026-08-09T10:00:00.000Z',
    );
    await rotateRuntimeTokenHash(
      auth,
      await hashRuntimeToken(secondToken),
      '2026-08-09T10:05:00.000Z',
      overlapEndsAt,
    );

    const rows = await listRuntimeTokens(auth);
    expect(rows).toEqual([
      expect.objectContaining({
        createdAt: '2026-08-09T10:00:00.000Z',
        expiresAt: overlapEndsAt,
      }),
      expect.objectContaining({
        createdAt: '2026-08-09T10:05:00.000Z',
        expiresAt: null,
      }),
    ]);

    const duringOverlap = createRuntimeTokenAuthorizer(auth, () => '2026-08-09T10:14:59.000Z');
    expect(
      await duringOverlap({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${firstToken}`,
      }),
    ).toBe(true);
    expect(
      await duringOverlap({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${secondToken}`,
      }),
    ).toBe(true);

    const afterOverlap = createRuntimeTokenAuthorizer(auth, () => '2026-08-09T10:15:00.000Z');
    expect(
      await afterOverlap({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${firstToken}`,
      }),
    ).toBe('This token is not valid for this build.');
    expect(
      await afterOverlap({
        method: 'GET',
        path: '/v1/build',
        authorization: `Bearer ${secondToken}`,
      }),
    ).toBe(true);

    expect(await revokeRuntimeTokens(auth)).toBe(2);
    expect(await hasRuntimeToken(auth)).toBe(false);

    expect(
      db.prepare('SELECT token_hash FROM runtime_tokens ORDER BY token_hash').all() as Array<{
        token_hash: string;
      }>,
    ).toEqual([]);
  });
});
