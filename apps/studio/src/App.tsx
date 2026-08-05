import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import './App.css';
import { Badge, toneForFreshness } from './components/primitives.js';
import { client } from './lib/api.js';

/**
 * The shell: a persistent build header, five routes, and nothing else.
 *
 * The header is the anchor of the whole interface rather than a breadcrumb. Everything on
 * every route is relative to one immutable, content-addressed build, and architecture 4.10
 * says freshness travels with the answer, so the build id and source state are on screen
 * permanently. It reads like the label on a specimen: quiet, always present, unambiguous.
 */

/**
 * `needs` names a capability the build must declare for the link to appear.
 *
 * Only Tables has one. Section 15.5 asks for the view "when structured data exists", and the
 * honest test for that is the capability list `describeBuild` already returns: a build
 * declares `table-query` exactly when it imported a table. A second probe, such as calling
 * `listTables` and counting, would be a different question that happens to agree today.
 */
const ROUTES = [
  { to: '/', label: 'Overview', end: true },
  { to: '/sources', label: 'Sources', end: false },
  { to: '/tables', label: 'Tables', end: false, needs: 'table-query' },
  { to: '/playground', label: 'Playground', end: false },
  { to: '/versions', label: 'Versions', end: false },
  { to: '/diagnostics', label: 'Diagnostics', end: false },
] as const;

export function App(): React.JSX.Element {
  const build = useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
  });
  const capabilities = build.data?.capabilities ?? [];

  return (
    <div className="app">
      {/* First in the tab order, and the only way past a sticky header and the nav links for
          someone navigating by keyboard. It lives here rather than in index.html so the
          component tests and the accessibility suite both see it. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <BuildHeader />
      <nav className="nav" aria-label="Studio sections">
        {ROUTES.filter((route) => !('needs' in route) || capabilities.includes(route.needs)).map(
          (route) => (
            <NavLink
              key={route.to}
              to={route.to}
              end={route.end}
              className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
            >
              {route.label}
            </NavLink>
          ),
        )}
      </nav>
      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

function BuildHeader(): React.JSX.Element {
  const build = useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
    // Watch mode can land a rebuild at any moment, and the header is where a person finds
    // out. Short enough to feel live, long enough not to poll a local server pointlessly.
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });

  const data = build.data;

  return (
    <header className="header">
      <div className="header-project">
        <span className="header-name">{data?.projectName ?? 'Lorepack'}</span>
      </div>

      <div className="header-build">
        {data === undefined ? (
          <span className="header-id header-id-pending">reading build</span>
        ) : (
          // Keyed on the build id so React replaces the node when the build changes, which is
          // what makes the crossfade fire. The single animated moment in the product, and the
          // only moment the underlying truth moves without the user acting.
          <span key={data.buildId} className="header-id" title={data.buildId}>
            {data.shortBuildId}
          </span>
        )}
      </div>

      <div className="header-state">
        {data !== undefined && (
          <Badge tone={toneForFreshness(data.sourceState)}>{data.sourceState}</Badge>
        )}
        {data !== undefined && data.capabilities.length > 0 && (
          <span className="header-capabilities">{data.capabilities.join(' ')}</span>
        )}
      </div>

      {/* Announced rather than shown: a person reading the screen already sees the header
          change, and a person who is not needs telling that the world moved. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {data === undefined ? '' : `Active build ${data.shortBuildId}, sources ${data.sourceState}`}
      </span>
    </header>
  );
}
