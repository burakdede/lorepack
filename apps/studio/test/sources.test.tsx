import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sources } from '../src/routes/Sources.js';

/**
 * Sources, which answers "exactly what was parsed, and exactly what was not".
 *
 * The second half is the one that gets buried. Architecture 6.9 makes exclusion transparency
 * a promise, because a document a person believes is indexed and is not is the most expensive
 * way for this product to be wrong: every answer afterwards is confidently incomplete.
 */

const ARTIFACTS = [
  {
    artifactId: 'p:docs/runbook.md',
    relativePath: 'docs/runbook.md',
    displayPath: 'docs/runbook.md',
    title: 'Release runbook',
    status: 'active',
    authority: 80,
    mediaType: 'text/markdown',
    objectHash: 'a'.repeat(64),
    byteSize: 2048,
    parserId: 'markdown',
    chunkCount: 4,
    nodeCount: 11,
  },
  {
    artifactId: 'p:docs/old.md',
    relativePath: 'docs/old.md',
    displayPath: 'docs/old.md',
    title: null,
    status: 'archived',
    authority: 10,
    mediaType: 'text/markdown',
    objectHash: 'b'.repeat(64),
    byteSize: 512,
    parserId: 'markdown',
    chunkCount: 1,
    nodeCount: 2,
  },
];

const EXCLUDED = {
  groups: [
    {
      class: 'unsupported-file',
      warnings: [
        {
          code: 'LORE_W_UNSUPPORTED',
          path: 'docs/diagram.png',
          message: 'docs/diagram.png has no supported parser, so it was not indexed.',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/v1/sources')) {
        return new Response(JSON.stringify({ buildId: 'lore_x', artifacts: ARTIFACTS }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(EXCLUDED), { status: 200 });
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
      <Sources />
    </QueryClientProvider>,
  );
}

describe('what was parsed', () => {
  it('lists every artifact with its status and counts in scannable columns', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getByText('docs/runbook.md')).toBeInTheDocument());
    expect(screen.getByText('docs/old.md')).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('opens a detail view with provenance and the facts a build recorded', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('docs/runbook.md')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'docs/runbook.md' }));

    const detail = await screen.findByRole('complementary', { name: /docs\/runbook\.md/ });
    expect(detail).toHaveTextContent('markdown');
    expect(detail).toHaveTextContent('Release runbook');
    // The content hash, because "which bytes is this" is the question a build id answers at
    // the project level and this answers at the file level.
    expect(detail).toHaveTextContent('aaaaaaaaaaaaaaaa');
  });

  it('filters by path and by status', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('docs/runbook.md')).toBeInTheDocument());

    await userEvent.type(screen.getByRole('searchbox'), 'archived');
    await waitFor(() => expect(screen.queryByText('docs/runbook.md')).not.toBeInTheDocument());
    expect(screen.getByText('docs/old.md')).toBeInTheDocument();
  });
});

describe('what was not parsed', () => {
  it('is one click away, not buried in a collapsed section', async () => {
    renderRoute();

    // The amendment on #66: a person opens this route to find out why a document is missing,
    // and an appendix at the bottom of the page is unreachable unless you know to look.
    const excluded = await screen.findByRole('button', { name: /excluded 1/ });
    expect(excluded).toBeInTheDocument();

    await userEvent.click(excluded);
    expect(await screen.findByText('docs/diagram.png')).toBeInTheDocument();
    expect(screen.getByText('unsupported-file')).toBeInTheDocument();
  });

  it('gives the exact reason, without repeating the path into the sentence', async () => {
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: /excluded 1/ }));

    expect(
      await screen.findByText('Has no supported parser, so it was not indexed.'),
    ).toBeInTheDocument();
  });

  it('says so plainly when nothing was excluded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/v1/sources')
          ? new Response(JSON.stringify({ buildId: 'lore_x', artifacts: ARTIFACTS }), {
              status: 200,
            })
          : new Response(JSON.stringify({ groups: [] }), { status: 200 }),
      ),
    );
    renderRoute();

    await userEvent.click(await screen.findByRole('button', { name: /excluded 0/ }));
    expect(
      await screen.findByText('Nothing was excluded. Every file in scope is in this build.'),
    ).toBeInTheDocument();
  });
});

describe('read-only, per architecture 15.6', () => {
  it('offers nothing that could change a source file', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getByText('docs/runbook.md')).toBeInTheDocument());

    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    for (const forbidden of ['Edit', 'Delete', 'Rename', 'Save', 'Remove']) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
