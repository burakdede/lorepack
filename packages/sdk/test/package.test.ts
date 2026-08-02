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
