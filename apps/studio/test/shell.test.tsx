import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

/**
 * The shell, which is mostly one promise: whatever route you are on, the build it refers to
 * is on screen.
 *
 * Architecture 4.10 says freshness travels with the answer. In an inspector that means the
 * build id and source state are never more than a glance away, because every number on every
 * route is relative to them.
 */

vi.mock('../src/lib/api.js', () => ({
  client: {
    describeBuild: vi.fn(async () => ({
      buildId: `lore_${'a'.repeat(64)}`,
      shortBuildId: 'lore_aaaaaaaaaaaa',
      sourceState: 'clean',
      projectName: 'examined',
      capabilities: ['lexical-search'],
      counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 0, tableRows: 0 },
      warningCount: 0,
      schemaVersion: 1,
      compilerVersion: '0.1.0',
      createdAt: '2026-08-03T12:00:00.000Z',
    })),
  },
  toDisplayable: (error: unknown) => ({ message: String(error) }),
}));

function renderShell(): void {
  const router = createMemoryRouter(
    [{ path: '/', element: <App />, children: [{ index: true, element: <p>route content</p> }] }],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('the persistent build header', () => {
  it('names the build every route is relative to, and its freshness', async () => {
    renderShell();

    await waitFor(() => expect(screen.getByText('lore_aaaaaaaaaaaa')).toBeInTheDocument());
    expect(screen.getByText('clean')).toBeInTheDocument();
    expect(screen.getByText('examined')).toBeInTheDocument();
  });

  it('carries the full build id, because a short one is for reading and not for citing', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByText('lore_aaaaaaaaaaaa')).toBeInTheDocument());

    expect(screen.getByText('lore_aaaaaaaaaaaa')).toHaveAttribute(
      'title',
      `lore_${'a'.repeat(64)}`,
    );
  });

  it('announces the build to a reader who cannot see the header change', async () => {
    renderShell();

    // Watch mode changes this without the user acting, which is exactly the case a live
    // region exists for.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Active build lore_aaaaaaaaaaaa'),
    );
  });
});

describe('navigation', () => {
  it('offers the five routes architecture 15.5 fixes, and no more', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Studio sections' });

    // Five, deliberately. Search is a tab inside the Playground and Plan is a panel on
    // Overview, so neither is a sixth section.
    const links = nav.querySelectorAll('a');
    expect([...links].map((link) => link.textContent)).toEqual([
      'Overview',
      'Sources',
      'Playground',
      'Versions',
      'Diagnostics',
    ]);
  });

  it('gives keyboard users a way past the header', () => {
    renderShell();
    expect(screen.getByText('Skip to content')).toHaveAttribute('href', '#main');
  });
});
