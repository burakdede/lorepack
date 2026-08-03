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

beforeEach(() => {
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
      return new Response(JSON.stringify(HISTORY), { status: 200 });
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
    expect(posted).toEqual([{ url: '/v1/builds/activate', body: { build: OLD } }]);
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

describe('the diff, which has to read the way lore diff reads', () => {
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
