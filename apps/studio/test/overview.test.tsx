import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Overview } from '../src/routes/Overview.js';

/**
 * Overview, which answers "what is my AI seeing, is it current, and what would a rebuild
 * change?"
 *
 * Half of these assert what the route must **not** become. The amendment on #65 is explicit
 * that counts here are facts about one immutable build rather than metrics over time, so
 * there is no delta to show and nothing to plot, and the route that will attract stat tiles
 * hardest is this one.
 */

const BUILD = {
  buildId: `lore_${'a'.repeat(64)}`,
  shortBuildId: 'lore_aaaaaaaaaaaa',
  sourceState: 'clean' as string,
  projectName: 'examined',
  capabilities: ['lexical-search'],
  counts: { artifacts: 184, nodes: 1200, chunks: 12418, tables: 0, tableRows: 0 },
  warningCount: 0,
  schemaVersion: 1,
  compilerVersion: '0.1.0',
  createdAt: '2026-08-03T12:00:00.000Z',
};

const describeBuild = vi.fn();

vi.mock('../src/lib/api.js', () => ({
  client: { describeBuild: (...args: unknown[]) => describeBuild(...args) },
  toDisplayable: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
    ...(typeof (error as { code?: string }).code === 'string'
      ? { code: (error as { code: string }).code }
      : {}),
  }),
}));

function renderRoute(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Overview />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  describeBuild.mockReset();
  describeBuild.mockResolvedValue({ ...BUILD });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ total: 0, groups: [] }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the build contains', () => {
  it('shows the counts as labelled facts, with the full id available to copy', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());
    expect(screen.getByText('12,418')).toBeInTheDocument();
    expect(screen.getByText('lore_aaaaaaaaaaaa')).toHaveAttribute('title', BUILD.buildId);
    // A short id is for reading. A bug report needs the whole thing.
    expect(screen.getByLabelText(`Copy build id ${BUILD.buildId}`)).toBeInTheDocument();
  });

  it('omits tables entirely when the build has none', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());
    // A row reading "Tables 0" is furniture. Tables arrive in Phase 5 and the row arrives
    // with them.
    expect(screen.queryByText('Tables')).not.toBeInTheDocument();
  });
});

describe('freshness, which is the question the route exists for', () => {
  it('says plainly that the AI is reading what is on disk', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText(/reading what is on disk/)).toBeInTheDocument());
  });

  it('says what dirty actually means, and gives the command that fixes it', async () => {
    describeBuild.mockResolvedValue({ ...BUILD, sourceState: 'dirty' });
    renderRoute();

    await waitFor(() => expect(screen.getByText(/reading the older text/)).toBeInTheDocument());
    // Not "your build is stale": the consequence, and the one command that ends it.
    expect(screen.getByText('lorepack build')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy command lorepack build')).toBeInTheDocument();
  });
});

describe('a project that is new rather than broken', () => {
  it('invites the next command instead of reporting an error', async () => {
    describeBuild.mockRejectedValue(
      Object.assign(new Error('This project has no build to serve.'), {
        code: 'LORE_E_BUILD_NOT_FOUND',
      }),
    );
    renderRoute();

    await waitFor(() =>
      expect(screen.getByText('This project has no build yet.')).toBeInTheDocument(),
    );
    expect(screen.getByText('lorepack build')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('planning', () => {
  it('does not run until asked, because it reads every source file', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());

    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).includes('/v1/plan'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Plan a rebuild' })).toBeInTheDocument();
  });
});

describe('warnings, which is where a reader goes to find a file', () => {
  /**
   * #203. The path and the sentence sat in adjacent spans with a margin between them and
   * nothing in the document, so the row read as `context/notes/logo.binHas no supported
   * parser` to a screen reader, and copying it produced the same string. A path a reader
   * cannot copy is not much use in a warning about a file.
   *
   * Asserting on `textContent` rather than on the two spans is the point. Both spans were
   * always there, and axe saw nothing wrong: the markup is valid and the words are present.
   */
  it('separates the path from the sentence with real text, not a margin', async () => {
    describeBuild.mockResolvedValue({ ...BUILD, warningCount: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              total: 1,
              groups: [
                {
                  class: 'unsupported-file',
                  count: 1,
                  warnings: [
                    {
                      code: 'unsupported-format',
                      path: 'context/notes/logo.bin',
                      message:
                        'context/notes/logo.bin has no supported parser, so it was not indexed.',
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    renderRoute();

    const path = await screen.findByText('context/notes/logo.bin');
    expect(path.closest('li')?.textContent).toBe(
      'context/notes/logo.bin Has no supported parser, so it was not indexed.',
    );
  });
});

describe('what this route must not become', () => {
  it('plots nothing and shows no trend, because a build has no history to trend', async () => {
    const { container } = { container: document.body };
    renderRoute();
    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());

    // The anti-brief on #64, asserted rather than reviewed.
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('presents counts as an aligned key-value block, not as tiles', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());

    // A definition list is the shape that echoes `lorepack build` and keeps the labels in a
    // column the eye can scan. Tiles would each be their own little box.
    const value = screen.getByText('184');
    expect(value.tagName).toBe('DD');
    expect(value.closest('dl')).not.toBeNull();
  });
});

describe('getting a developer from `lorepack dev` to a connected client', () => {
  const CLIENTS = [
    {
      id: 'claude-code',
      title: 'Claude Code',
      installed: true,
      version: '2.1.0',
      supported: true,
      configured: false,
      ownedByLorepack: false,
    },
    {
      id: 'codex',
      title: 'Codex',
      installed: true,
      supported: true,
      configured: true,
      ownedByLorepack: true,
    },
    {
      id: 'vscode',
      title: 'VS Code',
      installed: false,
      supported: true,
      configured: false,
      ownedByLorepack: false,
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/v1/diagnostics')
          ? new Response(JSON.stringify({ clients: CLIENTS }), { status: 200 })
          : String(url).includes('/v1/plan')
            ? new Response(
                JSON.stringify({
                  artifacts: { added: 1, changed: 0, removed: 0, reused: 5 },
                  lock: { changed: false },
                }),
                { status: 200 },
              )
            : new Response(JSON.stringify({ total: 0, groups: [] }), { status: 200 }),
      ),
    );
  });

  it('shows the endpoints this process serves, on the address Studio is open at', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('184')).toBeInTheDocument());

    const origin = window.location.origin;
    expect(screen.getByText(`${origin}/mcp`)).toBeInTheDocument();
    expect(screen.getByText(`${origin}/v1`)).toBeInTheDocument();
    expect(screen.getByText('lorepack mcp')).toBeInTheDocument();
  });

  it('offers a connect command only for a client that is installed and not yet connected', async () => {
    renderRoute();
    await waitFor(() =>
      expect(screen.getByText('lorepack connect claude-code')).toBeInTheDocument(),
    );

    // Running it for a connected client changes nothing, and for a missing one it only fails.
    expect(screen.queryByText('lorepack connect codex')).not.toBeInTheDocument();
    expect(screen.queryByText('lorepack connect vscode')).not.toBeInTheDocument();
    expect(screen.getByText('not installed')).toBeInTheDocument();
  });

  it('counts connected clients in the next step, and plans a rebuild from it', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('1 connected')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Open Playground' })).toHaveAttribute(
      'href',
      '#/playground',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Preview a rebuild' }));
    // The step and the panel are one action, so the panel shows the plan it asked for.
    await waitFor(() => expect(screen.getByText('Reused')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Plan a rebuild' })).not.toBeInTheDocument();
  });
});
