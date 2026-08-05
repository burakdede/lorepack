import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Citation } from '../components/Citation.js';
import { Adjacent, Badge, Empty, Fact, Facts, Failure, Loading } from '../components/primitives.js';
import { client, type DisplayableError, toDisplayable } from '../lib/api.js';
import './Tables.css';

/**
 * The typed tables a build contains, and a console for asking them questions.
 *
 * Two things about this route are load-bearing rather than stylistic.
 *
 * **The console reaches the same surface a model does.** It posts to
 * `POST /v1/tables/:id/query`, which goes through #77's validator, per-query authorizer and
 * deadline. Nothing reachable from this page is unreachable from `lore_query_table`, and the
 * way to keep that true is one implementation rather than two that agree today.
 *
 * **The generated names are on screen.** A query has to address `t_orders_8003...` and
 * `c_0_sku`, never `Orders` and `sku`, so a schema view that showed only the source names
 * would be describing a table you cannot query. That is what #235 fixed in the port, and this
 * is the surface that makes it usable: the prefilled statement is assembled from the
 * description, so the first thing a person runs is already correct.
 */

interface TableSummary {
  readonly tableId: string;
  readonly name: string;
}

interface ColumnStatistics {
  readonly nullCount: number;
  readonly distinctEstimate: number;
  readonly distinctIsExact: boolean;
  readonly min?: string | number | boolean;
  readonly max?: string | number | boolean;
}

interface Column {
  readonly name: string;
  readonly sqlName: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly statistics: ColumnStatistics;
}

export function Tables(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);

  const tables = useQuery({
    queryKey: ['tables'],
    queryFn: ({ signal }) => client.listTables(signal),
  });

  const list = useMemo(() => tables.data?.tables ?? [], [tables.data]);
  const current = selected ?? list[0]?.tableId ?? null;

  // The heading is outside every branch, so the route is identifiable while it is loading,
  // while it is failing, and when it is empty. The browser suite waits on it.
  const titled = (body: React.ReactNode): React.JSX.Element => (
    <>
      <h1 className="route-title">Tables</h1>
      {body}
    </>
  );

  if (tables.isPending) return titled(<Loading label="Reading the table catalog" />);
  if (tables.isError) return titled(<Failure {...toDisplayable(tables.error)} />);

  if (list.length === 0) {
    return titled(
      <Empty title="This build contains no tables.">
        <p>
          CSV and spreadsheet files become typed tables; other formats become text. Add one and run{' '}
          <code>lore build</code>.
        </p>
      </Empty>,
    );
  }

  return titled(
    <section className="tables" aria-label="Typed tables">
      <nav className="tables-list" aria-label="Tables in this build">
        <ul>
          {list.map((table: TableSummary) => (
            <li key={table.tableId}>
              <button
                type="button"
                className={table.tableId === current ? 'tables-item tables-item-on' : 'tables-item'}
                aria-current={table.tableId === current}
                onClick={() => setSelected(table.tableId)}
              >
                {table.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {current === null ? null : <TableDetail tableId={current} />}
    </section>,
  );
}

function TableDetail({ tableId }: { readonly tableId: string }): React.JSX.Element {
  const described = useQuery({
    queryKey: ['table', tableId],
    queryFn: ({ signal }) => client.describeTable(tableId, signal),
  });

  if (described.isPending) return <Loading label="Reading the table" />;
  if (described.isError) return <Failure {...toDisplayable(described.error)} />;

  const table = described.data;
  const columns = table.columns as readonly Column[];

  return (
    <div className="tables-detail">
      <h2 className="tables-title">{table.name}</h2>

      <Facts>
        <Fact label="Rows">{table.rowCount.toLocaleString('en-US')}</Fact>
        <Fact label="Columns">{columns.length}</Fact>
        {/* The name a query addresses. Nothing else in the interface shows it. */}
        <Fact label="SQL name">{table.sqlName}</Fact>
        <Fact label="Source">
          <Citation locator={table.locator} />
        </Fact>
      </Facts>

      <h3 className="tables-heading">Schema</h3>
      <div className="table-scroll">
        {/* Named, because three tables appear on this page and a screen reader listing them
            as "table, table, table" is no better than none. */}
        <table className="tables-schema" aria-label={`${table.name} schema`}>
          <thead>
            <tr>
              <th scope="col">column</th>
              <th scope="col">sql name</th>
              <th scope="col">type</th>
              <th scope="col">nulls</th>
              <th scope="col">distinct</th>
              <th scope="col">range</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.sqlName}>
                <th scope="row" className="tables-column-name">
                  {/* A real text node between the two, so a screen reader and a copied
                      selection both get a word boundary (#203). */}
                  <Adjacent lead={column.name}>
                    {column.nullable ? (
                      <Badge tone="idle">nullable</Badge>
                    ) : (
                      <Badge tone="idle">required</Badge>
                    )}
                  </Adjacent>
                </th>
                <td className="tables-sql-name">{column.sqlName}</td>
                <td>{column.type}</td>
                <td>{column.statistics.nullCount.toLocaleString('en-US')}</td>
                <td>
                  {/* An estimate is marked as one rather than presented as a count. It is
                      exact below a bounded cardinality and a lower bound above it. */}
                  {column.statistics.distinctIsExact ? '' : 'at least '}
                  {column.statistics.distinctEstimate.toLocaleString('en-US')}
                </td>
                <td className="tables-range">{formatRange(column.statistics)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="tables-heading">First rows</h3>
      <p className="tables-note prose">
        A sample of the stored rows, to show the shape. Use the console below to ask anything else.
      </p>
      <Grid
        label={`${table.name} sample rows`}
        columns={columns.map((column) => column.name)}
        rows={table.sample}
      />

      <QueryConsole
        tableId={tableId}
        sqlName={table.sqlName}
        columns={columns.map((column) => column.sqlName)}
      />
    </div>
  );
}

function formatRange(statistics: ColumnStatistics): string {
  if (statistics.min === undefined) return '';
  return `${String(statistics.min)} .. ${String(statistics.max)}`;
}

/**
 * The console.
 *
 * Prefilled from the description, because the names a query needs are generated and nobody
 * guesses `c_0_sku`. Reset when the table changes, so the statement always names the table
 * on screen rather than the one that was on screen a moment ago.
 */
function QueryConsole({
  tableId,
  sqlName,
  columns,
}: {
  readonly tableId: string;
  readonly sqlName: string;
  readonly columns: readonly string[];
}): React.JSX.Element {
  const starting = useMemo(
    () => `SELECT ${columns.join(', ')}\n  FROM ${sqlName}\n LIMIT 20`,
    [columns, sqlName],
  );
  const [sql, setSql] = useState(starting);
  const [ran, setRan] = useState<string | null>(null);
  useEffect(() => {
    setSql(starting);
    setRan(null);
  }, [starting]);

  const result = useQuery({
    queryKey: ['table-query', tableId, ran],
    queryFn: ({ signal }) => client.queryTable(tableId, ran as string, {}, signal),
    enabled: ran !== null,
    retry: false,
  });

  return (
    <section className="console" aria-label="Query console">
      <h3 className="tables-heading">Console</h3>
      <p className="tables-note prose">
        One read-only <code>SELECT</code>, over this table, through the same validator and the same
        limits as the model-facing tool. It cannot write, and it cannot read anything else.
      </p>

      <form
        className="console-form"
        onSubmit={(event) => {
          event.preventDefault();
          setRan(sql);
        }}
      >
        <label className="console-label" htmlFor="console-sql">
          SQL
        </label>
        <textarea
          id="console-sql"
          className="console-input"
          value={sql}
          spellCheck={false}
          rows={4}
          onChange={(event) => setSql(event.target.value)}
        />
        <div className="console-actions">
          <button type="submit" className="console-run">
            Run query
          </button>
          <button
            type="button"
            className="console-reset"
            onClick={() => {
              setSql(starting);
            }}
          >
            Reset
          </button>
        </div>
      </form>

      {ran === null ? null : <ConsoleResult query={result} />}
    </section>
  );
}

interface ConsoleQuery {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data:
    | { columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }
    | undefined;
}

function ConsoleResult({ query }: { readonly query: ConsoleQuery }): React.JSX.Element {
  if (query.isPending) return <Loading label="Running the query" />;
  if (query.isError) {
    // The taxonomy's own words. A rejected statement says which rule it broke and what to do,
    // and paraphrasing that into something friendlier would lose the part that helps.
    const displayable: DisplayableError = toDisplayable(query.error);
    return <Failure {...displayable} />;
  }
  const data = query.data;
  if (data === undefined) return <Loading label="Running the query" />;

  return (
    <div className="console-result">
      <p className="console-count" role="status">
        {data.rows.length === 0
          ? 'No rows.'
          : `${data.rows.length.toLocaleString('en-US')} ${data.rows.length === 1 ? 'row' : 'rows'}.`}
        {data.truncated ? ' Truncated at the row limit, so there are more.' : ''}
      </p>
      <Grid label="Query result" columns={data.columns} rows={data.rows} />
    </div>
  );
}

/**
 * A result grid, inside its own scroll box.
 *
 * `.table-scroll` rather than letting the page widen: a wide table that pushes the document
 * sideways takes the navigation with it, which is what the 200% zoom check found on Versions
 * (#210). A query console is the most likely thing in this phase to do it again.
 */
function Grid({
  label,
  columns,
  rows,
}: {
  readonly label: string;
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}): React.JSX.Element {
  if (rows.length === 0) return <p className="tables-note prose">No rows.</p>;

  return (
    <div className="table-scroll">
      <table className="tables-grid" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // Row order is the query's answer and rows carry no id, so the index is the
            // identity here. The list is replaced wholesale on every run.
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable id
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className={cellClass(row[column])}>
                  {formatCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A stored value, written as it is.
 *
 * **Not localized.** A cell is data, not a count: a reader may copy it into a query, a
 * spreadsheet or a report, and `4,210.5` is not a number any of those accept. Grouping
 * separators also made the sample disagree with the range in the schema directly above it,
 * which prints `4210.5`, and two spellings of one value on one screen is the defect this
 * phase has spent its time on.
 *
 * Counts elsewhere on the page keep their separators, because a row count is for a person to
 * read rather than for anything to consume.
 *
 * A null is a fact about the data, so it is written rather than left as an empty cell.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function cellClass(value: unknown): string {
  if (value === null || value === undefined) return 'cell cell-null';
  if (typeof value === 'number') return 'cell cell-number';
  return 'cell';
}
