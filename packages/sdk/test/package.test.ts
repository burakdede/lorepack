import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoreClient, LoreClientError } from '../src/index.js';

/**
 * What this package promises about itself.
 *
 * The zero-dependency claim is the whole reason an agent author can add Lorepack without
 * inheriting a compiler or a schema library, so it is asserted rather than remembered.
 */

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string>; files?: string[]; exports?: unknown };

describe('exact retained-build selection, issue432', () => {
  const first = `lore_${'a'.repeat(64)}`;
  const second = `lore_${'b'.repeat(64)}`;

  it('carries one selected build through every read capability and preserves a base path', async () => {
    const seen: string[] = [];
    const client = new LoreClient({
      baseUrl: 'https://runtime.test/project',
      buildId: first,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toMatch(/^\/project\/v1\//);
        const selection =
          init?.body === undefined
            ? url.searchParams.get('buildId')
            : (JSON.parse(String(init.body)) as { buildId: string }).buildId;
        expect(selection).toBe(first);
        seen.push(url.pathname);
        return Response.json({ buildId: first, tables: [] });
      },
    });
    await client.describeBuild();
    await client.search({ query: 'rollback' });
    await client.contextForTask({ task: 'rollback' });
    await client.readSource('guide');
    await client.listSources();
    await client.listTables();
    await client.describeTable('pricing');
    await client.queryTable('pricing', 'SELECT price FROM prices');
    expect(seen).toHaveLength(8);
  });

  it('rejects a server that silently answers with the active build or omits proof', async () => {
    for (const reply of [{ buildId: second }, { tables: [] }]) {
      let calls = 0;
      const client = new LoreClient({
        baseUrl: 'https://runtime.test',
        buildId: first,
        fetch: async () => {
          calls += 1;
          return Response.json(reply);
        },
      });
      await expect(client.describeBuild()).rejects.toMatchObject({
        code: 'LORE_E_SCHEMA_MISMATCH',
        subject: first,
      });
      expect(calls).toBe(1);
    }
  });

  it('lets an explicit per-request selection replace the client default', async () => {
    const client = new LoreClient({
      baseUrl: 'https://runtime.test',
      buildId: first,
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ buildId: second });
        return Response.json({ buildId: second });
      },
    });
    expect((await client.search({ query: 'rollback', buildId: second })).buildId).toBe(second);
  });

  it('pins table catalog and detail reads to the requested build', async () => {
    const seen: string[] = [];
    const client = new LoreClient({
      baseUrl: 'https://runtime.test',
      buildId: first,
      fetch: async (input) => {
        const url = new URL(String(input));
        seen.push(url.searchParams.get('buildId') ?? '');
        return Response.json({ buildId: second });
      },
    });
    await client.listTables(undefined, second);
    await client.describeTable('pricing', undefined, second);
    expect(seen).toEqual([second, second]);
  });
});

describe('the package', () => {
  it('has no runtime dependencies at all', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('ships its build and its documentation, and nothing else', () => {
    expect(manifest.files).toContain('dist');
    expect(manifest.files).toContain('README.md');
  });

  it('is small, because a client that is not small stops being installed', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client.ts'), 'utf8');
    const contracts = readFileSync(join(import.meta.dirname, '..', 'src', 'contracts.ts'), 'utf8');
    // A ceiling, not a target. It exists so a future addition is a decision rather than a
    // drift, and the numbers are generous enough that formatting never trips it.
    expect(source.length + contracts.length).toBeLessThan(20_000);
  });
});

describe('the client uses only what a Worker also has', () => {
  it('constructs without a fetch, because the platform provides one', () => {
    expect(() => new LoreClient({ baseUrl: 'http://127.0.0.1:4321' })).not.toThrow();
  });

  it('normalises a base URL with a trailing slash', async () => {
    let seen = '';
    const client = new LoreClient({
      baseUrl: 'http://runtime.test/',
      retries: 1,
      fetch: async (input) => {
        seen = String(input);
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });
    await client.health();
    expect(seen).toBe('http://runtime.test/health');
  });

  it('sends a bearer token when one is configured, and nothing when not', async () => {
    const headers: Array<string | null> = [];
    const make = (token?: string) =>
      new LoreClient({
        baseUrl: 'http://runtime.test',
        retries: 1,
        ...(token === undefined ? {} : { token }),
        fetch: async (_input, init) => {
          headers.push(new Headers(init?.headers).get('Authorization'));
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        },
      });

    await make('abc123').health();
    await make().health();
    expect(headers).toEqual(['Bearer abc123', null]);
  });
});

describe('LoreClientError', () => {
  it('is an Error, so existing handling still works', () => {
    const error = new LoreClientError({ code: 'LORE_E_INTERNAL', message: 'boom', status: 500 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LoreClientError');
    expect(error.code).toBe('LORE_E_INTERNAL');
  });
});
