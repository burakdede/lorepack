import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { App } from './App.js';
import { Diagnostics } from './routes/Diagnostics.js';
import { Overview } from './routes/Overview.js';
import { Playground } from './routes/Playground.js';
import { Sources } from './routes/Sources.js';
import { Tables } from './routes/Tables.js';
import { Versions } from './routes/Versions.js';
import './styles.css';

/**
 * Hash routing, deliberately.
 *
 * Studio is served as static assets from the same Hono app that answers `/v1`, and a browser
 * routing scheme is not worth teaching that server about. A hash keeps every deep link
 * working without a server-side rewrite rule, which is one fewer thing to get wrong in the
 * Phase 6 projection.
 */
const router = createHashRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'sources', element: <Sources /> },
      // Registered unconditionally even though the nav link is conditional. A build with no
      // tables hides the link; a deep link to `#/tables` still has to answer, and it answers
      // with the route's own empty state rather than with a blank page.
      { path: 'tables', element: <Tables /> },
      { path: 'playground', element: <Playground /> },
      { path: 'versions', element: <Versions /> },
      { path: 'diagnostics', element: <Diagnostics /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A local server answering in milliseconds does not need aggressive caching, and an
      // inspector showing a stale build would be lying about the one thing it exists to say.
      staleTime: 1000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('Studio could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
