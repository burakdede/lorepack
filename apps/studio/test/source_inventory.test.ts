import { afterEach, expect, it, vi } from 'vitest';
import { fetchSources } from '../src/lib/api.js';

afterEach(() => vi.unstubAllGlobals());

it('loads every source page pinned to the first build', async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      expect(init.signal).toBe(signal);
      const next = calls.length > 1;
      return new Response(
        JSON.stringify({
          buildId: 'lore_first',
          artifacts: [{ artifactId: next ? 'last' : 'first' }],
          nextOffset: next ? null : 50,
        }),
      );
    }),
  );
  expect(await fetchSources({ signal })).toEqual({
    buildId: 'lore_first',
    artifacts: [{ artifactId: 'first' }, { artifactId: 'last' }],
  });
  expect(calls).toEqual(['/v1/sources', '/v1/sources?buildId=lore_first&offset=50']);
});

it('refuses a page from a different build', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            buildId: ++calls === 1 ? 'lore_first' : 'lore_other',
            artifacts: [],
            nextOffset: calls === 1 ? 50 : null,
          }),
        ),
    ),
  );
  await expect(fetchSources({ signal: new AbortController().signal })).rejects.toThrow(
    'changed builds',
  );
});

it('does not silently show a partial list when the selected build is unavailable', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ buildId: 'lore_first', artifacts: [], nextOffset: 50 }))
        : new Response('{}', { status: 404 }),
    ),
  );
  await expect(fetchSources({ signal: new AbortController().signal })).rejects.toThrow(
    'does not list sources',
  );
});

it('refuses a non-advancing continuation instead of looping', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            buildId: 'lore_first',
            artifacts: [],
            nextOffset: 50,
          }),
        ),
    ),
  );
  await expect(fetchSources({ signal: new AbortController().signal })).rejects.toThrow(
    'did not advance',
  );
});
