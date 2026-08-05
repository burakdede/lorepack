import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tables } from '../src/routes/Tables.js';

/**
 * The Tables route.
 *
 * The assertions here are mostly **equalities between what is on screen and what the response
 * said**, rather than checks that something is present. That is the shape the Phase 4 audit
 * identified as the one that catches this class: every defect that phase found lived in a
 * disagreement between two representations of one thing, and every assertion that missed them
 * was a presence check.
 *
 * The particular equality that matters here is between the statement the console offers and
 * the names the description reported. A schema view showing only source names would look
 * complete and describe a table nobody can query.
 */

const ORDERS = {
  buildId: `lore_${'a'.repeat(64)}`,
  sourceState: 'clean',
  tableId: 'p:orders.xlsx#orders',
  name: 'Orders',
  sqlName: 't_orders_80032d995f73',
  sheet: 'Orders',
  rowCount: 3,
  columns: [
    {
      name: 'sku',
      sqlName: 'c_0_sku',
      type: 'text',
      nullable: false,
      statistics: {
        nullCount: 0,
        distinctEstimate: 3,
        distinctIsExact: true,
        min: 'A-1',
        max: 'A-3',
      },
    },
    {
      name: 'qty',
      sqlName: 'c_1_qty',
      type: 'integer',
      nullable: false,
      statistics: { nullCount: 0, distinctEstimate: 3, distinctIsExact: true, min: 2, max: 9 },
    },
    {
      name: 'active',
      sqlName: 'c_2_active',
      type: 'boolean',
      nullable: true,
      // Not exact, so the interface has to say so rather than print a count.
      statistics: {
        nullCount: 1,
        distinctEstimate: 2,
        distinctIsExact: false,
        min: false,
        max: true,
      },
    },
  ],
  sample: [
    { sku: 'A-1', qty: 5, active: true },
    { sku: 'A-2', qty: 2, active: false },
    { sku: 'A-3', qty: 9, active: null },
  ],
  locator: {
    artifactId: 'p:orders.xlsx',
    relativePath: 'orders.xlsx',
    sheet: 'Orders',
    cellRange: 'A1:D4',
  },
};

const LIST = { tables: [{ tableId: ORDERS.tableId, name: 'Orders' }] };

/** What the server says when the validator refuses a statement. The taxonomy's own words. */
const REJECTED = {
  error: {
    code: 'LORE_E_SQL_REJECTED',
    message: 'Only SELECT is allowed here, and this statement begins with DELETE.',
    remediation: 'This surface is read-only by design: no model-facing tool may write.',
  },
};

const QUERY_RESULT = {
  buildId: ORDERS.buildId,
  sourceState: 'clean',
  columns: ['sku', 'qty'],
  rows: [
    { sku: 'A-3', qty: 9 },
    { sku: 'A-1', qty: 5 },
  ],
  rowCount: 2,
  truncated: true,
  locator: ORDERS.locator,
};

const listTables = vi.fn();
const describeTable = vi.fn();
const queryTable = vi.fn();

/**
 * The API module, not `globalThis.fetch`.
 *
 * The SDK client is a module-level singleton constructed at import time, so a global stub
 * installed in `beforeEach` arrives too late to be seen. Mocking the module is the pattern
 * the other client-backed routes already use.
 */
vi.mock('../src/lib/api.js', () => ({
  client: {
    listTables: (...args: unknown[]) => listTables(...args),
    describeTable: (...args: unknown[]) => describeTable(...args),
    queryTable: (...args: unknown[]) => queryTable(...args),
  },
  toDisplayable: (error: unknown) => {
    const body = (error as { error?: Record<string, string> } | null)?.error;
    if (body !== undefined) return body;
    return { message: error instanceof Error ? error.message : String(error) };
  },
}));

beforeEach(() => {
  listTables.mockResolvedValue(LIST);
  describeTable.mockResolvedValue(ORDERS);
  queryTable.mockResolvedValue(QUERY_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderRoute(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Tables />
    </QueryClientProvider>,
  );
}

describe('the schema a build recorded', () => {
  it('shows every column with the generated name a query has to use', async () => {
    renderRoute();
    const schema = within(await screen.findByRole('table', { name: 'Orders schema' }));

    for (const column of ORDERS.columns) {
      expect(schema.getByText(column.name)).toBeInTheDocument();
      // The equality that matters: the generated name is on screen, not merely the source
      // name. Without it the page describes a table that cannot be queried.
      expect(schema.getByText(column.sqlName)).toBeInTheDocument();
    }
  });

  it('reports the statistics beside the column, and marks an estimate as one', async () => {
    renderRoute();
    const schema = within(await screen.findByRole('table', { name: 'Orders schema' }));

    const activeRow = schema.getByRole('row', { name: /active/ });
    // `distinctIsExact: false` means a floor, so the number is never shown bare.
    expect(activeRow).toHaveTextContent('at least 2');

    const skuRow = schema.getByRole('row', { name: /sku/ });
    expect(skuRow).toHaveTextContent('A-1 .. A-3');
    // Exact, so no hedge.
    expect(skuRow).not.toHaveTextContent('at least');
  });

  it('cites the sheet and cell range the table was read from', async () => {
    renderRoute();
    await screen.findByRole('table', { name: 'Orders schema' });

    // Provenance is mandatory, and for a spreadsheet that means a range, not just a file.
    // The whole citation as one string: a citation that lost a part should fail here rather
    // than pass on the parts it kept. It is rendered across several spans, so the assertion
    // is on the assembled text rather than on a single node.
    const citation = screen.getByText('Source').closest('.fact')?.querySelector('.citation');
    // Without the copy button's own label, which is a control rather than part of the citation.
    citation?.querySelector('.citation-copy')?.remove();
    expect(citation?.textContent).toBe('orders.xlsx · Orders · A1:D4');
  });

  it('spells a value the same way in the sample and in the range', async () => {
    // The defect this pins: the grid localized numbers and the range did not, so one screen
    // showed `4,210.5` and `4210.5` for one value. A cell is also data a reader may paste
    // into a query, and a grouping separator makes it something no query accepts.
    describeTable.mockResolvedValue({
      ...ORDERS,
      columns: [
        {
          name: 'cost',
          sqlName: 'c_0_cost',
          type: 'real',
          nullable: false,
          statistics: {
            nullCount: 0,
            distinctEstimate: 1,
            distinctIsExact: true,
            min: 4210.5,
            max: 4210.5,
          },
        },
      ],
      sample: [{ cost: 4210.5 }],
    });
    renderRoute();

    const schema = within(await screen.findByRole('table', { name: 'Orders schema' }));
    const sample = within(await screen.findByRole('table', { name: 'Orders sample rows' }));

    expect(schema.getByText('4210.5 .. 4210.5')).toBeInTheDocument();
    expect(sample.getByText('4210.5')).toBeInTheDocument();
    expect(sample.queryByText('4,210.5')).toBeNull();
  });

  it('writes a null rather than leaving the cell blank', async () => {
    renderRoute();
    const sample = within(await screen.findByRole('table', { name: 'Orders sample rows' }));

    // A blank cell and a null are different facts about the data, and only one of them is
    // true here. `true` and `false` are words too, not 1 and 0.
    expect(sample.getByRole('row', { name: /A-3/ })).toHaveTextContent('null');
    expect(sample.getByRole('row', { name: /A-1/ })).toHaveTextContent('true');
    expect(sample.getByRole('row', { name: /A-2/ })).toHaveTextContent('false');
  });
});

describe('the console', () => {
  it('offers a statement built from the names the description reported', async () => {
    renderRoute();
    const input = await screen.findByLabelText('SQL');

    // Not "contains SELECT": the offered statement must name this table and these columns,
    // because a statement assembled from the source names would be refused.
    const value = (input as HTMLTextAreaElement).value;
    expect(value).toContain('t_orders_80032d995f73');
    for (const column of ORDERS.columns) expect(value).toContain(column.sqlName);
  });

  it('sends exactly what is in the box, and shows the rows that come back', async () => {
    renderRoute();
    const input = await screen.findByLabelText('SQL');

    await userEvent.clear(input);
    await userEvent.type(input, 'SELECT c_0_sku FROM t_orders_80032d995f73');
    await userEvent.click(screen.getByRole('button', { name: 'Run query' }));

    await waitFor(() => expect(queryTable).toHaveBeenCalled());
    expect(queryTable.mock.calls[0]?.[1]).toBe('SELECT c_0_sku FROM t_orders_80032d995f73');

    const result = within(await screen.findByRole('table', { name: 'Query result' }));
    expect(result.getByRole('row', { name: /A-3/ })).toBeInTheDocument();
  });

  it('says a truncated result is truncated rather than implying it is complete', async () => {
    renderRoute();
    await screen.findByLabelText('SQL');
    await userEvent.click(screen.getByRole('button', { name: 'Run query' }));

    // Silent truncation would make a partial answer look like the whole table, which is the
    // one thing a result count may never do.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 rows'));
    expect(screen.getByRole('status')).toHaveTextContent(/Truncated/);
  });

  it('reports a rejection in the taxonomy\u2019s words, with its code and remediation', async () => {
    queryTable.mockRejectedValue(REJECTED);
    renderRoute();
    await screen.findByLabelText('SQL');
    await userEvent.click(screen.getByRole('button', { name: 'Run query' }));

    const alert = await screen.findByRole('alert');
    // The server's own sentence, not a friendlier paraphrase that loses the rule.
    expect(alert).toHaveTextContent('Only SELECT is allowed here');
    expect(alert).toHaveTextContent('LORE_E_SQL_REJECTED');
    expect(alert).toHaveTextContent('read-only by design');
  });
});

describe('a build with no tables', () => {
  it('says so and names the command, rather than rendering an empty grid', async () => {
    listTables.mockResolvedValue({ tables: [] });
    renderRoute();

    await waitFor(() =>
      expect(screen.getByText('This build contains no tables.')).toBeInTheDocument(),
    );
    expect(screen.getByText('lore build')).toBeInTheDocument();
  });
});
