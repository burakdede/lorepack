import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Diagnostics } from '../src/routes/Diagnostics.js';

/**
 * Diagnostics, which is `lore doctor` rendered.
 *
 * The value of this route is entirely in the remediation reaching the reader intact, so most
 * of what is asserted here is that nothing summarises, scores or truncates it. The amendment
 * on #69 is explicit that an aggregate health figure is the wrong shape: an environment is
 * not a percentage, it is a list of things, two of which are wrong.
 */

const REPORT = {
  doctor: {
    status: 'fail',
    project: '/home/dev/demo',
    checks: [
      {
        id: 'node-version',
        title: 'Node version',
        status: 'pass',
        detail: 'Node v24.15.0',
        values: { detected: 'v24.15.0', execPath: '/usr/bin/node' },
      },
      {
        id: 'fts5',
        title: 'SQLite FTS5',
        status: 'fail',
        detail: 'SQLite 3.50.4 has no FTS5.',
        remediation:
          'Install Node from https://nodejs.org/en/download rather than a distribution build, which may link a shared SQLite without FTS5.',
      },
      {
        id: 'watcher-limits',
        title: 'Watcher limits',
        status: 'warn',
        detail: 'inotify allows 8192 watches, and this project has 6000 files.',
        remediation: 'Raise fs.inotify.max_user_watches, or narrow `sources` in lore.yaml.',
      },
    ],
    counts: { pass: 1, warn: 1, fail: 1 },
  },
  environment: {
    node: 'v24.15.0',
    platform: 'linux 7.0.0',
    arch: 'x64',
    sqlite: '3.50.4',
    fts5: false,
    lorepack: '0.1.0',
  },
  session: {
    host: '127.0.0.1',
    port: 43110,
    pid: 4242,
    startedAt: '2026-08-03T10:00:00.000Z',
    watcher: {
      state: 'clean',
      watchedPaths: 128,
      lastEventAt: '2026-08-03T10:05:00.000Z',
      lastRebuild: {
        at: '2026-08-03T10:05:01.000Z',
        durationMs: 92,
        created: true,
        failed: false,
      },
      rebuilds: 3,
      noOps: 1,
    },
  },
  clients: [
    {
      id: 'claude-code',
      title: 'Claude Code',
      installed: true,
      version: '2.1.0',
      supported: true,
      configured: true,
      ownedByLorepack: true,
      configPath: '/home/dev/demo/.claude/settings.local.json',
    },
  ],
};

let served: unknown = REPORT;
let calls = 0;

beforeEach(() => {
  served = REPORT;
  calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify(served), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRoute(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Diagnostics />
    </QueryClientProvider>,
  );
}

describe('the checks', () => {
  it('renders every check with its state as a word, not only a colour', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('Node version')).toBeInTheDocument());
    expect(screen.getByText('SQLite FTS5')).toBeInTheDocument();
    expect(screen.getByText('Watcher limits')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();
    expect(screen.getByText('warn')).toBeInTheDocument();
  });

  it('shows the remediation whole, because it is a thing a person runs', async () => {
    renderRoute();

    const remediation = await screen.findByText(/Install Node from https:\/\/nodejs\.org/);
    // Not truncated, not reflowed into a tooltip, and selectable where it sits.
    expect(remediation.textContent).toContain('which may link a shared SQLite without FTS5');
  });

  it('shows the detected values a check found', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('/usr/bin/node')).toBeInTheDocument());
  });
});

describe('what this route must never do', () => {
  it('counts the checks and never scores them', async () => {
    renderRoute();

    await waitFor(() =>
      expect(screen.getByText('1 passed, 1 to look at, 1 failed')).toBeInTheDocument(),
    );
    // An environment is not 67 percent well. The amendment on #69 forbids the dial, the
    // percentage and the traffic-light hero for exactly that reason.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(document.querySelector('progress')).toBeNull();
    expect(document.querySelector('meter')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('shows client paths and states, never configuration contents', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.getByText('/home/dev/demo/.claude/settings.local.json')).toBeInTheDocument();
    // Section 15.6: those files hold other people's servers and other people's credentials.
    expect(document.body.textContent).not.toMatch(/token|secret|password|api[_-]?key/i);
  });
});

describe('live session state, which a one-shot command cannot show', () => {
  it('reports the watcher, the port and the process', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('127.0.0.1:43110')).toBeInTheDocument());
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('128 paths')).toBeInTheDocument();
    expect(screen.getByText(/92 ms, new build/)).toBeInTheDocument();
  });

  it('says plainly when there is no watcher, rather than inventing a state for it', async () => {
    served = { ...REPORT, session: { ...REPORT.session, watcher: null } };
    renderRoute();

    expect(
      await screen.findByText(
        'Not watching. This server serves the active build and never rebuilds.',
      ),
    ).toBeInTheDocument();
  });

  it('distinguishes a rebuild that failed from one that changed nothing', async () => {
    served = {
      ...REPORT,
      session: {
        ...REPORT.session,
        watcher: {
          ...REPORT.session.watcher,
          lastRebuild: {
            at: '2026-08-03T10:05:01.000Z',
            durationMs: 40,
            created: false,
            failed: true,
          },
        },
      },
    };
    renderRoute();

    expect(await screen.findByText(/failed at .*40 ms/)).toBeInTheDocument();
  });
});

describe('re-running', () => {
  it('runs the checks again when asked, and says it is running', async () => {
    renderRoute();
    const button = await screen.findByRole('button', { name: 'Re-run checks' });
    await waitFor(() => expect(calls).toBe(1));

    await userEvent.click(button);

    await waitFor(() => expect(calls).toBe(2));
  });
});
