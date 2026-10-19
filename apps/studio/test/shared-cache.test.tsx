import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '../src/routes/Overview.js';
import { Sources } from '../src/routes/Sources.js';

/**
 * Routes share one query client in the app, so a query key is a contract between every route
 * that uses it. #401: Sources and Overview both read `/v1/warnings` under `['warnings']` and
 * each cached its own shape, so visiting Sources first crashed Overview.
 *
 * Component tests that render one route against a fresh client cannot see this, which is why
 * this one renders both against the same client, in the order a person navigates.
 */

vi.mock('../src/lib/api.js', async (original) => ({
  ...(await original<typeof import('../src/lib/api.js')>()),
  client: {
    describeBuild: vi.fn(async () => ({
      buildId: `lore_${'c'.repeat(64)}`,
      shortBuildId: 'lore_cccccccccccc',
      sourceState: 'clean',
      projectName: 'shared',
      capabilities: ['lexical-search'],
      counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 0, tableRows: 0 },
      warningCount: 1,
      schemaVersion: 1,
      compilerVersion: '0.1.0',
    })),
  },
}));

const WARNINGS = {
  total: 1,
  groups: [
    {
      class: 'unsupported-file',
      count: 1,
      warnings: [
        {
          code: 'unsupported-file',
          path: 'docs/diagram.bin',
          message: 'docs/diagram.bin has no supported parser, so it was not indexed.',
        },
      ],
    },
  ],
  exclusions: [],
  excludedByRule: 0,
};
const BUILD_C = `lore_${'c'.repeat(64)}`;
const BUILD_D = `lore_${'d'.repeat(64)}`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.startsWith('/v1/sources?')) {
        const buildId = new URL(target, 'http://localhost').searchParams.get('buildId');
        return new Response(JSON.stringify({ buildId, nextOffset: null, artifacts: [] }), {
          status: 200,
        });
      }
      if (target.startsWith('/v1/warnings?'))
        return new Response(
          JSON.stringify(
            target.includes(BUILD_D)
              ? {
                  ...WARNINGS,
                  groups: [
                    {
                      ...WARNINGS.groups[0],
                      warnings: [
                        {
                          ...WARNINGS.groups[0]?.warnings[0],
                          path: 'docs/revised.bin',
                          message: 'docs/revised.bin has no supported parser.',
                        },
                      ],
                    },
                  ],
                }
              : WARNINGS,
          ),
          { status: 200 },
        );
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routes that share a query key', () => {
  it('render Overview after Sources has cached the warnings', async () => {
    const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const sources = render(
      <QueryClientProvider client={shared}>
        <Sources />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(shared.getQueryState(['warnings', BUILD_C])?.status).toBe('success'),
    );
    sources.unmount();

    render(
      <QueryClientProvider client={shared}>
        <Overview />
      </QueryClientProvider>,
    );

    // The warning Overview lists comes from the same cache entry Sources filled.
    expect(await screen.findByText('docs/diagram.bin')).toBeInTheDocument();
    expect(screen.getByText('unsupported-file')).toBeInTheDocument();
  });

  it('replaces cached warnings after an external build change', async () => {
    const shared = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={shared}>
        <Sources />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'excluded 1' }));
    expect(await screen.findByText('docs/diagram.bin')).toBeVisible();

    act(() => {
      shared.setQueryData(['build'], {
        ...shared.getQueryData<object>(['build']),
        buildId: BUILD_D,
      });
    });
    expect(await screen.findByText('docs/revised.bin')).toBeVisible();
    expect(screen.queryByText('docs/diagram.bin')).not.toBeInTheDocument();
    expect(shared.getQueryState(['warnings', BUILD_D])?.status).toBe('success');
  });
});
