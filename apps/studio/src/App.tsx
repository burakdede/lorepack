import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import './App.css';
import { CommandPalette } from './components/CommandPalette.js';
import { Icon, type IconName, Mark } from './components/Icon.js';
import { Badge, toneForFreshness } from './components/primitives.js';
import { client } from './lib/api.js';
import { serverOrigin } from './lib/equivalents.js';
import { announceLocation } from './lib/location.js';
import { type ThemeChoice, useTheme } from './lib/theme.js';

/**
 * The shell: a sidebar that names the build, the sections, and nothing else.
 *
 * Everything on every route is relative to one immutable, content-addressed build, and
 * architecture 4.10 says freshness travels with the answer, so the build id and source state
 * sit at the top of the sidebar permanently. On a narrow screen the sidebar folds into a top
 * bar with the sections as a scrolling row beneath it; the sections never hide behind a
 * menu button, because a section a person cannot see is one they do not know exists.
 */

/**
 * `needs` names a capability the build must declare for the link to appear.
 *
 * Only Tables has one. Section 15.5 asks for the view "when structured data exists", and the
 * honest test for that is the capability list `describeBuild` already returns: a build
 * declares `table-query` exactly when it imported a table. A second probe, such as calling
 * `listTables` and counting, would be a different question that happens to agree today.
 */
const ROUTES: readonly {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
  readonly icon: IconName;
  readonly needs?: string;
}[] = [
  { to: '/', label: 'Overview', end: true, icon: 'overview' },
  { to: '/sources', label: 'Sources', end: false, icon: 'sources' },
  { to: '/tables', label: 'Tables', end: false, icon: 'tables', needs: 'table-query' },
  { to: '/playground', label: 'Playground', end: false, icon: 'playground' },
  { to: '/versions', label: 'Versions', end: false, icon: 'versions' },
  { to: '/diagnostics', label: 'Diagnostics', end: false, icon: 'diagnostics' },
];

const THEMES: readonly { readonly choice: ThemeChoice; readonly label: string }[] = [
  { choice: 'system', label: 'Match system theme' },
  { choice: 'light', label: 'Light theme' },
  { choice: 'dark', label: 'Dark theme' },
];

export function App(): React.JSX.Element {
  const build = useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
    // Watch mode can land a rebuild at any moment, and the sidebar is where a person finds
    // out. Short enough to feel live, long enough not to poll a local server pointlessly.
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });
  const capabilities: readonly string[] = build.data?.capabilities ?? [];
  const routes = ROUTES.filter(
    (route) => route.needs === undefined || capabilities.includes(route.needs),
  );

  const { choice, setChoice } = useTheme();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Focus goes back to wherever it was when the palette opened, which is the half of a
  // dialog's contract that is easiest to forget.
  const returnFocus = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }, []);

  const go = useCallback(
    (to: string) => {
      void Promise.resolve(navigate(to)).then(announceLocation);
    },
    [navigate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, openPalette, closePalette]);

  return (
    <div className="app">
      {/* First in the tab order, and the only way past the sidebar for someone navigating
          by keyboard. It lives here rather than in index.html so the component tests and the
          accessibility suite both see it. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="sidebar">
        <div className="sidebar-brand">
          <Mark />
          <span className="sidebar-product">Lorepack Studio</span>
        </div>

        <BuildIdentity />

        <button
          type="button"
          className="search-trigger"
          aria-label="Jump to a route, source or table"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={openPalette}
        >
          <Icon name="search" />
          <span className="search-trigger-label">Jump to</span>
          <kbd className="kbd search-trigger-key">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>

        <nav className="nav" aria-label="Studio sections">
          {routes.map((route) => (
            <NavLink
              key={route.to}
              to={route.to}
              end={route.end}
              className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
            >
              <Icon name={route.icon} />
              {route.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <McpEndpoint />
          <fieldset className="theme-switch">
            <legend className="visually-hidden">Theme</legend>
            {THEMES.map((theme) => (
              <button
                key={theme.choice}
                type="button"
                className={
                  choice === theme.choice ? 'theme-option theme-option-on' : 'theme-option'
                }
                aria-pressed={choice === theme.choice}
                aria-label={theme.label}
                title={theme.label}
                onClick={() => setChoice(theme.choice)}
              >
                <Icon name={theme.choice} />
              </button>
            ))}
          </fieldset>
        </div>
      </header>

      <main className="main" id="main">
        <Outlet />
      </main>

      {paletteOpen && (
        <CommandPalette
          routes={routes}
          hasTables={capabilities.includes('table-query')}
          buildId={build.data?.buildId}
          onNavigate={go}
          onTheme={setChoice}
          onClose={closePalette}
        />
      )}
    </div>
  );
}

function BuildIdentity(): React.JSX.Element {
  const build = useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
  });
  const data = build.data;
  const [copied, setCopied] = useState(false);

  return (
    <div className="build-identity">
      <span className="header-name">{data?.projectName ?? 'Lorepack'}</span>
      <div className="build-identity-row">
        {data === undefined ? (
          <span className="header-id header-id-pending">reading build</span>
        ) : (
          // Keyed on the build id so React replaces the node when the build changes, which is
          // what makes the settle fire. The one moment the underlying truth moves without the
          // reader acting.
          <span key={data.buildId} className="header-id" title={data.buildId}>
            {data.shortBuildId}
          </span>
        )}
        {data !== undefined && (
          <button
            type="button"
            className="icon-button"
            aria-label={copied ? 'Copied build id' : `Copy build id ${data.buildId}`}
            title="Copy full build id"
            onClick={() => {
              void navigator.clipboard?.writeText(data.buildId).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            <Icon name="copy" />
          </button>
        )}
      </div>
      {data !== undefined && (
        <div className="build-identity-state">
          <Badge tone={toneForFreshness(data.sourceState)}>{data.sourceState}</Badge>
          <span className="build-identity-note">active build</span>
        </div>
      )}

      {/* Announced rather than shown: a person reading the screen already sees the sidebar
          change, and a person who is not needs telling that the world moved. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {data === undefined ? '' : `Active build ${data.shortBuildId}, sources ${data.sourceState}`}
      </span>
    </div>
  );
}

/**
 * The MCP endpoint, one click from any route, because "what URL do I give my agent" is the
 * question a developer has most often and should never need to navigate for.
 */
function McpEndpoint(): React.JSX.Element {
  const url = `${serverOrigin()}/mcp`;
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mcp-endpoint"
      title={url}
      aria-label={copied ? 'Copied MCP endpoint' : `Copy MCP endpoint ${url}`}
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      <span>{copied ? 'Copied' : 'MCP URL'}</span>
    </button>
  );
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
