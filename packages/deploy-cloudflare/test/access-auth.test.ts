import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCloudflareAccessAuthorizer,
  createCloudflareRequestAuthorizer,
  hashRuntimeToken,
  RUNTIME_TOKEN_PREFIX,
  type RuntimeAuthDatabaseLike,
  type RuntimeAuthStatementLike,
  resolveCloudflareAccessConfigFromBindings,
  storeRuntimeTokenHash,
} from '../src/index.js';

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
const originalFetch = globalThis.fetch;

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  globalThis.fetch = originalFetch;
});

function openRuntimeDatabase(): SqliteRuntimeDatabase {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return new SqliteRuntimeDatabase(db);
}

describe('cloudflare access auth, issue 90', () => {
  it('validates an Access JWT against the configured team domain and audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'issue-90';

    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe('https://lorepack.cloudflareaccess.com/cdn-cgi/access/certs');
      return new Response(JSON.stringify({ keys: [{ ...jwk, use: 'sig' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const token = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'issue-90' })
      .setIssuer('https://lorepack.cloudflareaccess.com')
      .setAudience('cf-access-aud')
      .setSubject('owner@example.com')
      .setIssuedAt(new Date('2026-08-09T12:00:00.000Z'))
      .setExpirationTime('10m')
      .sign(privateKey);

    const authorize = createCloudflareAccessAuthorizer({
      teamDomain: 'lorepack.cloudflareaccess.com',
      audience: 'cf-access-aud',
    });

    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers({ 'Cf-Access-Jwt-Assertion': token }),
        authorization: undefined,
      }),
    ).toBe(true);
  });

  it('rejects missing or invalid Access JWTs with one non-enumerating message', async () => {
    const authorize = createCloudflareAccessAuthorizer({
      teamDomain: 'lorepack.cloudflareaccess.com',
      audience: 'cf-access-aud',
      verifyToken: async (token) => token === 'good-access',
    });

    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers(),
        authorization: undefined,
      }),
    ).toBe('This request is not authorized for this build.');
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers({ 'Cf-Access-Jwt-Assertion': 'bad-access' }),
        authorization: undefined,
      }),
    ).toBe('This request is not authorized for this build.');
  });

  it('accepts either a runtime bearer token or a valid Access JWT when both are configured', async () => {
    const auth = openRuntimeDatabase();
    const runtimeToken = `${RUNTIME_TOKEN_PREFIX}access_or_bearer`;
    await storeRuntimeTokenHash(
      auth,
      await hashRuntimeToken(runtimeToken),
      '2026-08-09T12:00:00.000Z',
    );

    const authorize = createCloudflareRequestAuthorizer({
      runtimeAuthDb: auth,
      access: {
        teamDomain: 'lorepack.cloudflareaccess.com',
        audience: 'cf-access-aud',
        verifyToken: async (token) => token === 'good-access',
      },
    });

    if (authorize === undefined) throw new Error('expected authorizer');
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers(),
        authorization: `Bearer ${runtimeToken}`,
      }),
    ).toBe(true);
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers({ 'Cf-Access-Jwt-Assertion': 'good-access' }),
        authorization: undefined,
      }),
    ).toBe(true);
    expect(
      await authorize({
        method: 'GET',
        path: '/v1/build',
        headers: new Headers({ 'Cf-Access-Jwt-Assertion': 'bad-access' }),
        authorization: 'Bearer not-a-runtime-token',
      }),
    ).toBe('This request is not authorized for this build.');
  });

  it('parses Access config from bindings and fails on partial configuration', () => {
    expect(resolveCloudflareAccessConfigFromBindings({})).toBeUndefined();
    expect(
      resolveCloudflareAccessConfigFromBindings({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'lorepack.cloudflareaccess.com',
        CLOUDFLARE_ACCESS_AUD: 'cf-access-aud',
      }),
    ).toEqual({
      teamDomain: 'lorepack.cloudflareaccess.com',
      audience: 'cf-access-aud',
    });

    expect(() =>
      resolveCloudflareAccessConfigFromBindings({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'lorepack.cloudflareaccess.com',
      }),
    ).toThrow(/CLOUDFLARE_ACCESS_AUD/);
    expect(() =>
      resolveCloudflareAccessConfigFromBindings({
        CLOUDFLARE_ACCESS_AUD: 'cf-access-aud',
      }),
    ).toThrow(/CLOUDFLARE_ACCESS_TEAM_DOMAIN/);
  });
});
