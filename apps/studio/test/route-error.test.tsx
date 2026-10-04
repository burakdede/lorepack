import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { RouteError } from '../src/components/RouteError.js';

/**
 * A route that throws while rendering is replaced by Studio's own failure, inside the shell,
 * rather than by React Router's developer page in place of the whole app (#401).
 */

vi.mock('../src/lib/api.js', () => ({
  client: {
    describeBuild: vi.fn(async () => ({
      buildId: `lore_${'d'.repeat(64)}`,
      shortBuildId: 'lore_dddddddddddd',
      sourceState: 'clean',
      projectName: 'broken',
      capabilities: [],
      counts: { artifacts: 0, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
      warningCount: 0,
      schemaVersion: 1,
      compilerVersion: '0.1.0',
    })),
  },
  toDisplayable: (error: unknown) => ({ message: String(error) }),
}));

function Throws(): React.JSX.Element {
  throw new Error('Cannot read properties of undefined');
}

describe('a route that throws', () => {
  it('shows the real error inside the shell, with a way back', async () => {
    // React logs the caught error; the assertion is about what the reader sees.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <App />,
          errorElement: <RouteError />,
          children: [{ index: true, element: <Throws />, errorElement: <RouteError /> }],
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Something broke' })).toBeInTheDocument();
    expect(screen.getByText('Cannot read properties of undefined')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Overview' })).toHaveAttribute('href', '#/');
    // The shell survived: the sections are still there to move to.
    expect(screen.getByRole('navigation', { name: 'Studio sections' })).toBeInTheDocument();
    quiet.mockRestore();
  });
});
