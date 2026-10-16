import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Versions } from '../src/routes/Versions.js';

/**
 * Versions, which holds every action in the product that changes anything.
 *
 * These tests are mostly about wording and about what has to be true before a request is
 * sent. Section 15.6 asks for a plan and a confirmation, and the amendment on #68 asks the
 * button to carry the verb and the build id, because a button reading "Confirm" tells a
 * person nothing about which build they are about to make live.
 */

const NEW = `lore_${'a'.repeat(60)}0001`;
const OLD = `lore_${'b'.repeat(60)}0002`;

const HISTORY = {
  activeBuildId: NEW,
  rollbackBuildId: OLD as string | null,
  rollbackUnavailable: null as string | null,
  historyTruncated: false,
  activationHistory: [
    {
      generation: 2,
      previousBuildId: OLD as string | null,
      buildId: NEW,
      kind: 'transition',
      recordedAt: '2026-08-03T10:00:00.000Z',
    },
    {
      generation: 1,
      previousBuildId: null,
      buildId: OLD,
      kind: 'transition',
      recordedAt: '2026-08-02T09:00:00.000Z',
    },
  ],
  builds: [
    {
      buildId: NEW,
      createdAt: '2026-08-03T10:00:00.000Z',
      state: 'active',
      active: true,
      counts: { artifacts: 12, nodes: 90, chunks: 44, tables: 0, tableRows: 0 },
      capabilities: ['search', 'context'],
    },
    {
      buildId: OLD,
      createdAt: '2026-08-02T09:00:00.000Z',
      state: 'verified',
      active: false,
      counts: { artifacts: 11, nodes: 80, chunks: 40, tables: 0, tableRows: 0 },
      capabilities: ['search'],
    },
  ],
};

const DIFF = {
  from: OLD,
  to: NEW,
  identical: false,
  incompatibilities: [],
  artifacts: {
    added: 1,
    changed: 1,
    removed: 1,
    changes: [
      { path: 'docs/new.md', change: 'added' },
      { path: 'docs/runbook.md', change: 'changed' },
      { path: 'docs/gone.md', change: 'removed' },
    ],
  },
  rules: [{ path: 'docs/old.md', field: 'status', from: 'active', to: 'archived' }],
  chunks: { added: 4, changed: 1, removed: 2 },
  tables: [],
  capabilities: [
    { capability: 'search', change: 'same' },
    { capability: 'context', change: 'added' },
  ],
};

let posted: { url: string; body: unknown }[] = [];
let mutationResult: { status: number; body: unknown } = {
  status: 200,
  body: { buildId: OLD, generation: 7, changed: true },
};

/** What `GET /v1/builds` answers, which a test may move on as the CLI would. */
let history: typeof HISTORY = HISTORY;

beforeEach(() => {
  history = HISTORY;
  posted = [];
  mutationResult = { status: 200, body: { buildId: OLD, generation: 7, changed: true } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') {
        posted.push({ url: path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(mutationResult.body), { status: mutationResult.status });
      }
      if (path.includes('/diff/')) return new Response(JSON.stringify(DIFF), { status: 200 });
      return new Response(JSON.stringify(history), { status: 200 });
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
      <Versions />
    </QueryClientProvider>,
  );
}

describe('build history', () => {
  it('lists every build with its state, counts and capabilities', async () => {
    renderRoute();

    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    expect(
      screen.getByRole('rowheader', { name: new RegExp(OLD.slice(0, 17)) }),
    ).toBeInTheDocument();
    expect(screen.getByText('search context')).toBeInTheDocument();
    expect(screen.getAllByText('44')).not.toHaveLength(0);
  });

  it('marks the active build with a word, not only a row colour', async () => {
    renderRoute();

    // Greyscale, print, and a reader who cannot tell the tints apart all have to see which
    // build is live. It is the most important fact on the page.
    await waitFor(() =>
      expect(document.querySelector('.active-marker')?.textContent).toBe('active'),
    );
  });

  it('offers no activate button for the build that is already active', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));

    const activators = screen.getAllByRole('button', { name: /^Activate / });
    expect(activators).toHaveLength(1);
    expect(activators[0]).toHaveAccessibleName(`Activate ${OLD.slice(0, 17)}`);
  });
});

describe('confirmation, per section 15.6', () => {
  it('sends nothing until the action is confirmed', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));

    expect(posted).toHaveLength(0);
  });

  it('names the target build on the button instead of a generic confirmation word', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));

    const confirm = await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });
    expect(confirm).toBeInTheDocument();

    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    expect(labels).toContain(`Activate ${OLD.slice(0, 17)}`);
    for (const generic of ['Confirm', 'OK', 'Yes']) {
      expect(labels).not.toContain(generic);
    }
  });

  it('shows the real comparison as the plan, not a promise that something will change', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));

    const confirm = await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });
    expect(await within(confirm).findByText('docs/new.md')).toBeInTheDocument();
    expect(within(confirm).getByText('Artifacts')).toBeInTheDocument();
  });

  it('reports the result with the same verb the button used', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));
    const confirm = await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });
    await userEvent.click(
      within(confirm).getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }),
    );

    // "Activate" produces "Activated". A result that said "Switched" would leave a person
    // guessing whether it belonged to the button they pressed.
    expect(await screen.findByText(/^Activated /)).toBeInTheDocument();
    // `expectActive` is the build the plan said serving moves *from*, so a confirmation that
    // went stale is refused rather than applied to whatever is live now (#610).
    expect(posted).toEqual([
      { url: '/v1/builds/activate', body: { build: OLD, expectActive: NEW } },
    ]);
  });

  it('closes on Escape without sending anything', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));
    await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: `Activate ${OLD.slice(0, 17)}` }),
      ).not.toBeInTheDocument(),
    );
    expect(posted).toHaveLength(0);
  });
});

describe('a confirmation that went stale, #610', () => {
  it('re-plans from the build that is live now when the server refuses the activation', async () => {
    const THIRD = `lore_${'c'.repeat(60)}0003`;
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }));
    const confirm = await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });
    expect(confirm).toHaveTextContent(`Serving moves from ${NEW.slice(0, 17)}`);

    // Meanwhile the CLI activated a third build, and the server says so.
    history = {
      ...HISTORY,
      activeBuildId: THIRD,
      rollbackBuildId: NEW,
      activationHistory: [
        {
          generation: 3,
          previousBuildId: NEW,
          buildId: THIRD,
          kind: 'transition',
          recordedAt: '2026-08-03T11:00:00.000Z',
        },
        ...HISTORY.activationHistory,
      ],
      builds: [
        { ...HISTORY.builds[0], buildId: THIRD } as (typeof HISTORY.builds)[number],
        {
          ...(HISTORY.builds[0] as (typeof HISTORY.builds)[number]),
          state: 'verified',
          active: false,
        },
        HISTORY.builds[1] as (typeof HISTORY.builds)[number],
      ],
    };
    mutationResult = {
      status: 400,
      body: {
        error: {
          code: 'LORE_E_INVALID_ARGUMENT',
          message: 'The active build changed while this confirmation was open.',
          remediation: `${THIRD} is active now, not ${NEW}. Check the plan and confirm again.`,
        },
      },
    };
    await userEvent.click(
      within(confirm).getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }),
    );

    expect(
      await screen.findByText('The active build changed while this confirmation was open.'),
    ).toBeInTheDocument();
    const replanned = await screen.findByRole('region', { name: `Activate ${OLD.slice(0, 17)}` });
    await waitFor(() =>
      expect(replanned).toHaveTextContent(`Serving moves from ${THIRD.slice(0, 17)}`),
    );
    expect(screen.queryByText(/^Activated /)).not.toBeInTheDocument();
  });
});

describe('rollback is a pointer change, not a demolition', () => {
  it('says what it does and is not styled as destructive', async () => {
    renderRoute();

    const rollback = await screen.findByRole('button', { name: 'Roll back' });
    expect(rollback.className).not.toMatch(/danger|destructive/);
    expect(screen.getByText(/nothing is recompiled/i)).toBeInTheDocument();
  });

  it('names the build it would return to, and sends that build back for checking', async () => {
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));

    const confirm = await screen.findByRole('region', {
      name: `Roll back to ${OLD.slice(0, 17)}`,
    });
    await userEvent.click(
      within(confirm).getByRole('button', { name: `Roll back to ${OLD.slice(0, 17)}` }),
    );

    // `expect` is what makes a stale confirmation refusable: the history can move between
    // rendering this panel and confirming it.
    expect(posted).toEqual([{ url: '/v1/builds/rollback', body: { expect: OLD } }]);
    expect(await screen.findByText(/^Rolled back to /)).toBeInTheDocument();
  });
});

describe('pack', () => {
  it('reports the archive path and the member count', async () => {
    mutationResult = {
      status: 200,
      body: { buildId: NEW, archive: '/tmp/demo/demo-lore_aaaa.lorepack', members: 9 },
    };
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: `Pack ${NEW.slice(0, 17)}` }));
    const confirm = await screen.findByRole('region', { name: `Pack ${NEW.slice(0, 17)}` });
    await userEvent.click(
      within(confirm).getByRole('button', { name: `Pack ${NEW.slice(0, 17)}` }),
    );

    const outcome = await screen.findByText(/^Packed /);
    expect(outcome).toHaveTextContent('/tmp/demo/demo-lore_aaaa.lorepack');
    expect(outcome).toHaveTextContent('9 members');
  });
});

describe('failures', () => {
  it('renders the taxonomy error rather than a generic message, and changes nothing', async () => {
    mutationResult = {
      status: 400,
      body: {
        error: {
          code: 'LORE_E_INVALID_ARGUMENT',
          message: 'The build history changed while this confirmation was open.',
          remediation: 'Check the history and confirm again.',
        },
      },
    };
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    const confirm = await screen.findByRole('region', {
      name: `Roll back to ${OLD.slice(0, 17)}`,
    });
    await userEvent.click(
      within(confirm).getByRole('button', { name: `Roll back to ${OLD.slice(0, 17)}` }),
    );

    expect(
      await screen.findByText('The build history changed while this confirmation was open.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Check the history and confirm again.')).toBeInTheDocument();
    expect(screen.queryByText(/^Rolled back/)).not.toBeInTheDocument();
  });
});

describe('the diff, which has to read the way lorepack diff reads', () => {
  it('carries added, changed and removed with markers rather than colour alone', async () => {
    renderRoute();
    await waitFor(() => expect(screen.getAllByRole('rowheader')).toHaveLength(2));

    const added = await screen.findByText('docs/new.md');
    const row = added.closest('li');
    expect(row).toHaveTextContent('+');
    expect(screen.getByText('docs/gone.md').closest('li')).toHaveTextContent('-');
    expect(screen.getByText('docs/runbook.md').closest('li')).toHaveTextContent('~');
  });

  it('renders section 18.3 sections in section 18.3 order', async () => {
    renderRoute();

    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Artifacts',
      'Rules',
      'Context',
      'Tables',
      'Capabilities',
    ]);
  });
});

describe('recorded activation history', () => {
  it('uses the server target even when a newer never-active candidate is listed first', async () => {
    const candidate = `lore_${'c'.repeat(60)}0003`;
    history = {
      ...HISTORY,
      builds: [
        HISTORY.builds[0] as (typeof HISTORY.builds)[number],
        {
          ...HISTORY.builds[1],
          buildId: candidate,
          createdAt: '2026-08-03T09:59:00.000Z',
        } as (typeof HISTORY.builds)[number],
        HISTORY.builds[1] as (typeof HISTORY.builds)[number],
      ],
    };
    renderRoute();
    await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    expect(
      await screen.findByRole('region', { name: `Roll back to ${OLD.slice(0, 17)}` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: `Roll back to ${candidate.slice(0, 17)}` }),
    ).not.toBeInTheDocument();
    expect(posted).toEqual([]);
  });
  it('labels a legacy baseline and keeps explicit activation available without guessing a rollback', async () => {
    history = {
      ...HISTORY,
      rollbackBuildId: null,
      rollbackUnavailable: 'No previous activation is recorded.',
      activationHistory: [
        {
          generation: 2,
          previousBuildId: null,
          buildId: NEW,
          kind: 'baseline',
          recordedAt: '2026-08-03T10:00:00.000Z',
        },
      ],
    };
    renderRoute();
    expect(await screen.findByText(/No previous activation is recorded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roll back' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Activate ${OLD.slice(0, 17)}` }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByText('Activation history', { exact: true }));
    const region = screen.getByRole('region', { name: 'Recorded activations' });
    expect(within(region).getByText('Baseline observation')).toBeInTheDocument();
    expect(within(region).getByText('Unknown')).toBeInTheDocument();
    expect(posted).toEqual([]);
  });
  it('labels truncation and renders the bounded recorded events by generation', async () => {
    history = {
      ...HISTORY,
      historyTruncated: true,
      activationHistory: Array.from({ length: 50 }, (_, index) => ({
        generation: 51 - index,
        previousBuildId: index % 2 === 0 ? OLD : NEW,
        buildId: index % 2 === 0 ? NEW : OLD,
        kind: 'transition',
        recordedAt: '2026-08-03T10:00:00.000Z',
      })),
    };
    renderRoute();
    await userEvent.click(await screen.findByText('Activation history', { exact: true }));
    expect(screen.getByText(/Most recent 50 recorded events/)).toBeInTheDocument();
    const rows = within(screen.getByRole('region', { name: 'Recorded activations' })).getAllByRole(
      'row',
    );
    expect(rows).toHaveLength(51);
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')[0]).toHaveTextContent('51');
    expect(within(rows[50] as HTMLElement).getAllByRole('cell')[0]).toHaveTextContent('2');
  });
});
