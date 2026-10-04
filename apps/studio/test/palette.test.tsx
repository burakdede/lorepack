import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

/**
 * The shell's two additions: a theme the reader chooses, and an index of everything Studio
 * can open. Both are keyboard-first, and both must leave the page exactly as usable when
 * storage is unavailable.
 */

vi.mock('../src/lib/api.js', () => ({
  client: {
    describeBuild: vi.fn(async () => ({
      buildId: `lore_${'b'.repeat(64)}`,
      shortBuildId: 'lore_bbbbbbbbbbbb',
      sourceState: 'clean',
      projectName: 'examined',
      capabilities: ['lexical-search', 'table-query'],
      counts: { artifacts: 1, nodes: 1, chunks: 1, tables: 1, tableRows: 2 },
      warningCount: 0,
      schemaVersion: 1,
      compilerVersion: '0.1.0',
    })),
    listTables: vi.fn(async () => ({ tables: [{ tableId: 't1', name: 'orders' }] })),
  },
  fetchSources: vi.fn(async () => ({
    buildId: 'lore_b',
    artifacts: [
      { artifactId: 'a1', displayPath: 'docs/runbook.md', chunkCount: 3 },
      { artifactId: 'a2', displayPath: 'docs/pricing.md', chunkCount: 1 },
    ],
  })),
  toDisplayable: (error: unknown) => ({ message: String(error) }),
}));

function renderShell(): { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <App />,
        children: [
          { index: true, element: <p>overview content</p> },
          { path: 'sources', element: <p>sources content</p> },
          { path: 'tables', element: <p>tables content</p> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

beforeEach(() => {
  // jsdom lays nothing out, so it has no `scrollIntoView` to keep the active option visible.
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the theme control', () => {
  it('follows the system until the reader chooses, then remembers the choice', async () => {
    renderShell();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(screen.getByRole('button', { name: 'Match system theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('lore-studio-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Back to system forgets the stored choice rather than storing "system".
    await userEvent.click(screen.getByRole('button', { name: 'Match system theme' }));
    expect(window.localStorage.getItem('lore-studio-theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('the command palette', () => {
  it('opens from the keyboard, finds a source, and opens Sources on it', async () => {
    const { router } = renderShell();
    await userEvent.keyboard('{Meta>}k{/Meta}');

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(dialog).getByRole('combobox');
    expect(input).toHaveFocus();

    await userEvent.type(input, 'pricing');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: /docs\/pricing\.md/ })).toBeVisible(),
    );
    // The routes no longer match, so the first option is the source.
    expect(within(dialog).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sources');
    expect(router.state.location.search).toBe('?artifact=a2');
  });

  it('moves with the arrows and closes on Escape, giving focus back', async () => {
    renderShell();
    const trigger = screen.getByRole('button', { name: 'Jump to a route, source or table' });
    await userEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    const options = within(dialog).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('lists tables only when the build declares them, and says when nothing matches', async () => {
    renderShell();
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });

    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: /orders/ })).toBeInTheDocument(),
    );
    await userEvent.type(within(dialog).getByRole('combobox'), 'zzzz');
    expect(within(dialog).getByText('Nothing matches "zzzz".')).toBeInTheDocument();
  });
});
