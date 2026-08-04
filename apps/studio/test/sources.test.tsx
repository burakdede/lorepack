import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
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

/**
 * Both ways of not being in a build.
 *
 * The fixture carried only the warning until #202, and the route only rendered warnings, so
 * the two agreed and the missing half was invisible to every test. `exclusions` is the far
 * more common reason a document is absent: a rule removed it before anything was read.
 */
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
  exclusions: [
    {
      pattern: 'drafts/',
      source: '.loreignore',
      count: 3,
      sample: ['drafts/one.md', 'drafts/two.md'],
    },
    { pattern: 'lore.yaml', source: 'defaults', count: 1, sample: ['lore.yaml'] },
  ],
  excludedByRule: 4,
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

/** Serves a `/v1/warnings` body of the test's choosing, with the artifact list unchanged. */
function serve(excluded: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/v1/sources')
        ? new Response(JSON.stringify({ buildId: 'lore_x', artifacts: ARTIFACTS }), { status: 200 })
        : new Response(JSON.stringify(excluded), { status: 200 }),
    ),
  );
}

describe('what was not parsed', () => {
  it('is one click away, not buried in a collapsed section', async () => {
    renderRoute();

    // The amendment on #66: a person opens this route to find out why a document is missing,
    // and an appendix at the bottom of the page is unreachable unless you know to look.
    const excluded = await screen.findByRole('button', { name: /excluded 5/ });
    expect(excluded).toBeInTheDocument();

    await userEvent.click(excluded);
    expect(await screen.findByText('docs/diagram.png')).toBeInTheDocument();
    expect(screen.getByText('unsupported-file')).toBeInTheDocument();
  });

  it('gives the exact reason, without repeating the path into the sentence', async () => {
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: /excluded 5/ }));

    expect(
      await screen.findByText('Has no supported parser, so it was not indexed.'),
    ).toBeInTheDocument();
  });

  /**
   * #203. The class and the message sat in adjacent spans with a margin between them and
   * nothing in the document, so the row read as `unsupported-fileHas no supported parser`
   * to a screen reader and to anyone who copied it. Asserting on `textContent` rather than
   * on the two spans is the point: the spans were always both there.
   */
  it('separates the reason class from the sentence with real text, not a margin', async () => {
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: /excluded 5/ }));

    const cell = (await screen.findByText('unsupported-file')).closest('td');
    expect(cell?.textContent).toBe(
      'unsupported-file Has no supported parser, so it was not indexed.',
    );
  });

  /**
   * #202. The view was fed `/v1/warnings` and labelled the result "excluded", so it listed
   * only files the walk had read and could not parse. A file an ignore rule removed, which
   * is the usual reason a document is missing, appeared nowhere and was counted nowhere.
   */
  it('names the rule that removed a file, and where the rule came from', async () => {
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: /excluded 5/ }));

    expect(await screen.findByText('drafts/')).toBeInTheDocument();
    expect(screen.getByText('.loreignore')).toBeInTheDocument();
    expect(screen.getByText('drafts/one.md')).toBeInTheDocument();
    // The sample is bounded, so the rest is stated rather than silently dropped.
    expect(screen.getByText('and 1 more')).toBeInTheDocument();
    // Both layers, so a reader knows which file to open.
    expect(screen.getByText('defaults')).toBeInTheDocument();
  });

  /**
   * The assertion whose absence let the count lie.
   *
   * Every other test here names a thing and checks it is present. This one checks that the
   * number on the control is the number of things: `excluded 1` matched the fixture exactly
   * while a rule had removed four more, because the count and the list came from different
   * places and only one of them was ever asserted.
   */
  it('counts on the control exactly what the view lists', async () => {
    renderRoute();
    const control = await screen.findByRole('button', { name: /excluded \d+/ });
    const claimed = Number(/excluded (\d+)/.exec(control.textContent ?? '')?.[1]);

    await userEvent.click(control);
    await screen.findByText('drafts/');

    const byRule = EXCLUDED.exclusions.reduce((sum, one) => sum + one.count, 0);
    const discovered = EXCLUDED.groups.flatMap((group) => group.warnings).length;
    expect(claimed).toBe(byRule + discovered);
  });

  it('says so plainly when nothing was excluded', async () => {
    serve({ groups: [], exclusions: [], excludedByRule: 0 });
    renderRoute();

    await userEvent.click(await screen.findByRole('button', { name: /excluded 0/ }));
    expect(
      await screen.findByText('Nothing was excluded. Every file in scope is in this build.'),
    ).toBeInTheDocument();
  });

  /**
   * A build made before the record existed does not know, which is not the same as knowing
   * that nothing was excluded. Rendering the two the same way would be the defect this whole
   * change is about, one level down.
   */
  it('distinguishes a build that recorded nothing from one that has nothing to record', async () => {
    serve({ groups: [], exclusions: null, excludedByRule: null });
    renderRoute();

    await userEvent.click(await screen.findByRole('button', { name: /excluded 0/ }));
    expect(await screen.findByText(/predates the record/)).toBeInTheDocument();
    expect(
      screen.queryByText('Nothing was excluded. Every file in scope is in this build.'),
    ).not.toBeInTheDocument();
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
