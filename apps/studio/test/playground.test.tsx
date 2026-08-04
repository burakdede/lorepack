import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Playground } from '../src/routes/Playground.js';

/**
 * The Playground, where the product's honesty is most visible.
 *
 * Most of these assert wording and shape rather than data, because that is where this route
 * can go wrong. Section 4.5 forbids presenting a relevance score as truth, and section 13.4
 * forbids claiming a conflict was detected. Both are one careless caption away.
 */

/**
 * A bundle with something in every section.
 *
 * `overview` and `citations` were both empty here, and that is precisely why #199 survived:
 * the route rendered three of the six sections, and the fixture agreed with it. A fixture
 * that only contains what the component already draws cannot discover a section it forgot,
 * so every array the schema defines carries at least one item now.
 */
const BUNDLE = {
  task: 'how do I roll back a release',
  buildId: `lore_${'a'.repeat(64)}`,
  sourceState: 'clean',
  profile: 'agent',
  budget: 12000,
  estimatedTokens: 77,
  reservedTokens: 30,
  overview: [
    {
      chunkId: 'p:docs/releases.md@0',
      text: 'Release process. How a change reaches production, and how to undo one.',
      estimatedTokens: 30,
      headingPath: ['Release process'],
      labels: [],
      locator: {
        relativePath: 'docs/releases.md',
        headingPath: ['Release process'],
        lineStart: 1,
        lineEnd: 3,
      },
    },
  ],
  selected: [
    {
      chunkId: 'p:docs/runbook.md@0',
      text: 'Run lore rollback to point at the previous build.',
      estimatedTokens: 17,
      headingPath: ['Release runbook', 'Rolling back'],
      labels: [],
      locator: {
        relativePath: 'docs/runbook.md',
        headingPath: ['Release runbook', 'Rolling back'],
        lineStart: 9,
        lineEnd: 11,
      },
    },
  ],
  alternatives: [
    {
      chunkId: 'p:docs/old.md@0',
      text: 'The old rollback procedure.',
      estimatedTokens: 12,
      headingPath: ['Old'],
      labels: ['superseded'],
      locator: { relativePath: 'docs/old.md', lineStart: 3, lineEnd: 4 },
    },
  ],
  omitted: [
    {
      chunkId: 'p:docs/big.md@0',
      reason: 'budget',
      estimatedTokens: 1190,
      locator: { relativePath: 'docs/big.md', lineStart: 1, lineEnd: 400 },
    },
  ],
  // Everything the model receives, which is `overview` then `selected`, as the runtime
  // assembles it. This is the list the page is checked against.
  citations: [
    {
      relativePath: 'docs/releases.md',
      headingPath: ['Release process'],
      lineStart: 1,
      lineEnd: 3,
    },
    {
      relativePath: 'docs/runbook.md',
      headingPath: ['Release runbook', 'Rolling back'],
      lineStart: 9,
      lineEnd: 11,
    },
  ],
  tables: [{ tableId: 'p:data/releases.csv#releases', name: 'releases' }],
};

const SEARCH = {
  buildId: BUNDLE.buildId,
  sourceState: 'clean',
  totalIndexedChunks: 55,
  hits: [
    {
      chunkId: 'p:docs/runbook.md@0',
      artifactId: 'p:docs/runbook.md',
      score: 0.140824,
      excerpt: 'Run lore [rollback] to point at the previous build.',
      headingPath: ['Release runbook'],
      status: 'active',
      labels: [],
      locator: { relativePath: 'docs/runbook.md', lineStart: 9, lineEnd: 11 },
      scoreComponents: { lexical: 0.82, authority: 0.5, recency: 0.1, lexicalRaw: 5.43 },
    },
  ],
};

const contextForTask = vi.fn();
const search = vi.fn();

vi.mock('../src/lib/api.js', () => ({
  client: {
    contextForTask: (...args: unknown[]) => contextForTask(...args),
    search: (...args: unknown[]) => search(...args),
  },
  toDisplayable: (error: unknown) => ({ message: String(error) }),
}));

beforeEach(() => {
  contextForTask.mockReset().mockResolvedValue(BUNDLE);
  search.mockReset().mockResolvedValue(SEARCH);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRoute(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Playground />
    </QueryClientProvider>,
  );
}

async function assemble(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Task'), 'how do I roll back a release');
  await userEvent.click(screen.getByRole('button', { name: 'Assemble' }));
}

describe('assembling a bundle', () => {
  it('shows what was selected, with provenance on every item', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText(/Run lore rollback/)).toBeInTheDocument());
    // Invariant 5: a result without a locator is a bug, so the citation is not optional.
    expect(screen.getByText('docs/runbook.md')).toBeInTheDocument();
    expect(screen.getByText('9-11')).toBeInTheDocument();
  });

  it('labels every token figure as an estimate', async () => {
    renderRoute();
    await assemble();

    await waitFor(() =>
      expect(
        screen.getByText('Every figure is a conservative estimate, not an exact token count.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('12,000')).toBeInTheDocument();
  });

  it('refuses a budget outside the documented bounds, and says the bounds', async () => {
    renderRoute();
    await userEvent.type(screen.getByLabelText('Task'), 'a task');
    await userEvent.type(screen.getByLabelText('Budget'), '200');

    expect(await screen.findByText(/between 4,000 and 40,000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assemble' })).toBeDisabled();
  });

  /**
   * The assertion that generalises, and the one this route was missing.
   *
   * Every previous test named a section and checked its contents, so a section nobody named
   * was checked by nothing: the Playground rendered `selected`, `alternatives` and `omitted`
   * and silently dropped `overview` and `tables`, which is 40% of a bundle and, for the task
   * that found it, the only passage that answered the question (#199).
   *
   * `citations` is exactly "everything the model receives", so comparing the page against it
   * fails for any section added later and forgotten, without naming any section at all.
   */
  it('shows every passage the model receives, not only the selected ones', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText(/Run lore rollback/)).toBeInTheDocument());

    for (const citation of BUNDLE.citations) {
      expect(
        screen.getAllByText(citation.relativePath).length,
        `${citation.relativePath} is cited in the bundle and must be on the page`,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText(`${citation.lineStart}-${citation.lineEnd}`).length,
        `the lines for ${citation.relativePath} must be on the page`,
      ).toBeGreaterThan(0);
    }

    // The orientation passages are the ones that used to be missing, so their text is
    // asserted directly as well as through the citation above.
    expect(screen.getByText(/How a change reaches production/)).toBeInTheDocument();
  });

  it('accounts for the reserve rather than leaving it as a number with nothing behind it', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText('Orientation')).toBeInTheDocument());
    expect(screen.getByText('1, using 30 reserved')).toBeInTheDocument();
    // The count a reader can check against the page, and the reason the two cannot drift.
    expect(screen.getByText('Cited passages')).toBeInTheDocument();
    expect(screen.getByText(String(BUNDLE.citations.length))).toBeInTheDocument();
  });

  it('names the tables the bundle references', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText('tables')).toBeInTheDocument());
    expect(screen.getByText('releases')).toBeInTheDocument();
  });
});

describe('omissions, which are why this route is a debugger', () => {
  it('lists every omitted item with a reason a reader can act on', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText('docs/big.md')).toBeInTheDocument());
    // Not the enum value: "budget" alone tells a reader nothing they did not already suspect.
    expect(screen.getByText('did not fit the budget')).toBeInTheDocument();
  });

  it('shows them without anything needing to be expanded', async () => {
    renderRoute();
    await assemble();

    // The amendment on #67: collapsed below the fold, this route is a preview rather than a
    // debugger.
    await waitFor(() => expect(screen.getByText('docs/big.md')).toBeInTheDocument());
    expect(screen.getByText('docs/big.md').closest('details')).toBeNull();
  });
});

describe('what the interface must never claim', () => {
  it('describes alternatives as declared ranking, never as a detected conflict', async () => {
    renderRoute();
    await assemble();

    await waitFor(() => expect(screen.getByText(/Ranked lower by the status/)).toBeInTheDocument());
    // Invariant 6 and section 13.4. Lorepack never claims it detected a conflict or decided
    // which document is correct.
    expect(document.body.textContent).not.toMatch(/conflict/i);
    expect(document.body.textContent).not.toMatch(/out of date|outdated|incorrect/i);
  });

  it('presents relevance as a ranking heuristic and never as a score of truth', async () => {
    renderRoute();
    await userEvent.click(screen.getByRole('tab', { name: 'search' }));
    await userEvent.type(screen.getByLabelText('Query'), 'rollback');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByText(/ranking heuristic/)).toBeInTheDocument());
    expect(screen.getByText(/not a truth score/)).toBeInTheDocument();

    // The word may appear, and here it appears in a denial: "not a measure of correctness or
    // confidence". What is forbidden is *labelling a value* as confidence or accuracy, which
    // is what a reader would take as a claim.
    expect(document.body.textContent).not.toMatch(
      /(confidence|accuracy)\s*[:=]|(high|low)\s+(confidence|accuracy)|(confidence|accuracy)\s+score/i,
    );
  });

  it('shows the bounded score and never the raw lexical value', async () => {
    renderRoute();
    await userEvent.click(screen.getByRole('tab', { name: 'search' }));
    await userEvent.type(screen.getByLabelText('Query'), 'rollback');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByText(/relevance 0\.1408/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/relevance 0\.1408/));

    // Raw BM25 is not comparable across corpora (0.000002 on repetitive text, 5.43 on varied
    // prose), so displaying it makes the panel look broken on the corpora people test with.
    expect(screen.queryByText('lexicalRaw')).not.toBeInTheDocument();
    expect(screen.getByText('lexical')).toBeInTheDocument();
  });

  it('renders no bar, gauge or percentage for a score', async () => {
    renderRoute();
    await userEvent.click(screen.getByRole('tab', { name: 'search' }));
    await userEvent.type(screen.getByLabelText('Query'), 'rollback');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByText(/relevance 0\.1408/)).toBeInTheDocument());
    // Each of these reads as confidence no matter what the caption says.
    expect(document.querySelector('progress')).toBeNull();
    expect(document.querySelector('meter')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

describe('Studio is not a chat application', () => {
  it('offers no way to generate an answer', async () => {
    renderRoute();
    await assemble();
    await waitFor(() => expect(screen.getByText(/Run lore rollback/)).toBeInTheDocument());

    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    for (const forbidden of ['Ask', 'Generate', 'Send', 'Chat', 'Answer']) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
  });
});
