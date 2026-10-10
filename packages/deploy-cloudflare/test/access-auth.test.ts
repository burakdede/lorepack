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
import worker from '../src/worker.js';

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

/** Records every statement the Worker prepares, standing in for D1 billing. */
class RecordingRuntimeDatabase implements RuntimeAuthDatabaseLike {
  readonly statements: string[] = [];
  readonly #inner: SqliteRuntimeDatabase;

  constructor(inner: SqliteRuntimeDatabase) {
    this.#inner = inner;
  }

  prepare(query: string): RuntimeAuthStatementLike {
    this.statements.push(query.trim());
    return this.#inner.prepare(query);
  }

  writes(): string[] {
    return this.statements.filter((query) => !/^select\b/i.test(query));
  }
}

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

async function accessKeyFixture(teamDomain: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'issue-561';
  let certFetches = 0;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `https://${teamDomain}/cdn-cgi/access/certs`) {
      throw new Error(`unexpected fetch ${url}`);
    }
    certFetches += 1;
    return new Response(JSON.stringify({ keys: [{ ...jwk, use: 'sig' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    privateKey,
    certFetches: () => certFetches,
    token: () =>
      new SignJWT({ email: 'owner@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'issue-561' })
        .setIssuer(`https://${teamDomain}`)
        .setAudience('cf-access-aud')
        .setSubject('owner@example.com')
        .setIssuedAt(),
  };
}

describe('unauthenticated Worker requests cost no backend work, issue 561', () => {
  it('fetches Access keys at most once per isolate and never writes to D1', async () => {
    const teamDomain = 'issue-561-worker.cloudflareaccess.com';
    const keys = await accessKeyFixture(teamDomain);
    const { privateKey: strangerKey } = await generateKeyPair('RS256');
    const forged = await keys.token().setExpirationTime('10m').sign(strangerKey);
    const unsigned = `${btoa(JSON.stringify({ alg: 'none', kid: 'issue-561' }))}.${btoa('{}')}.`;

    const sqlite = openRuntimeDatabase();
    await storeRuntimeTokenHash(
      sqlite,
      await hashRuntimeToken('lore_rt_good'),
      '2026-08-09T00:00:00.000Z',
    );
    const db = new RecordingRuntimeDatabase(sqlite);
    const env = {
      CATALOG_DB: db as never,
      TABLES_DB: {} as never,
      OBJECTS: {} as never,
      PROJECT_ID: 'demo',
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain,
      CLOUDFLARE_ACCESS_AUD: 'cf-access-aud',
    };

    // The Worker builds a fresh app for every request, as it does in production.
    for (const access of [forged, unsigned, 'garbage', forged]) {
      const response = await worker.fetch(
        new Request('https://worker.example/v1/build', {
          headers: {
            Authorization: 'Bearer lore_rt_guessed',
            'Cf-Access-Jwt-Assertion': access,
          },
        }),
        env,
      );
      expect(response.status).toBe(401);
    }

    expect(keys.certFetches()).toBeLessThanOrEqual(1);
    expect(db.writes()).toEqual([]);
  });

  it('rejects an Access JWT that carries no expiry', async () => {
    const teamDomain = 'issue-561-exp.cloudflareaccess.com';
    const keys = await accessKeyFixture(teamDomain);
    const authorize = createCloudflareAccessAuthorizer({ teamDomain, audience: 'cf-access-aud' });
    const request = (token: string) => ({
      method: 'GET',
      path: '/v1/build',
      headers: new Headers({ 'Cf-Access-Jwt-Assertion': token }),
      authorization: undefined,
    });

    expect(await authorize(request(await keys.token().sign(keys.privateKey)))).toBe(
      'This request is not authorized for this build.',
    );
    expect(
      await authorize(request(await keys.token().setExpirationTime('10m').sign(keys.privateKey))),
    ).toBe(true);
  });
});
