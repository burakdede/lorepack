import type { ContextBundle, ContextItem, OmittedItem } from '@lorepack/sdk';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Citation } from '../components/Citation.js';
import { Badge, Empty, Fact, Facts, Failure, Loading } from '../components/primitives.js';
import { client, toDisplayable } from '../lib/api.js';
import './Playground.css';

/**
 * The debugging surface for retrieval, and the route where the product's honesty is most
 * visible.
 *
 * Two rules from the amendment on #67 shape almost every decision here.
 *
 * **A score must not be presented as a verdict.** A progress bar, a percentage or a gauge
 * reads as confidence no matter what the label above it says, so the breakdown is an aligned
 * arithmetic table: the components and their values. Section 13.2 calls this a relevance
 * heuristic and section 4.5 forbids presenting it as truth.
 *
 * **Omissions carry the same weight as selections.** The value of this route is that it shows
 * what an agent will *not* see. Collapsed below the fold it would be a preview rather than a
 * debugger.
 */

const PROFILES = ['agent', 'coding', 'chat', 'deep'] as const;
type Profile = (typeof PROFILES)[number];

/** Architecture 5.4's bounds, the same ones `lore export` enforces. */
const BUDGET_MIN = 4000;
const BUDGET_MAX = 40_000;

type Tab = 'context' | 'search';

export function Playground(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('context');

  return (
    <section>
      <h1 className="route-title">Playground</h1>

      {/* Search is a tab inside this route, not a sixth section. Architecture 15.5 is
          explicit, and the reason is that a query and a task are the same question asked at
          two levels of assembly. */}
      <div className="view-switch" role="tablist" aria-label="What to run">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'context'}
          className={tab === 'context' ? 'view-option view-option-active' : 'view-option'}
          onClick={() => setTab('context')}
        >
          context for a task
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'search'}
          className={tab === 'search' ? 'view-option view-option-active' : 'view-option'}
          onClick={() => setTab('search')}
        >
          search
        </button>
      </div>

      {tab === 'context' ? <ContextTab /> : <SearchTab />}
    </section>
  );
}

function ContextTab(): React.JSX.Element {
  const [task, setTask] = useState('');
  const [profile, setProfile] = useState<Profile>('agent');
  const [budget, setBudget] = useState('');
  const [copied, setCopied] = useState(false);

  const request = (): { task: string; profile: Profile; budget?: number } => ({
    task,
    profile,
    ...(budget.trim() === '' ? {} : { budget: Number(budget) }),
  });

  const run = useMutation({ mutationFn: () => client.contextForTask(request()) });

  const copyExport = useMutation({
    mutationFn: async () => {
      // The server renders it with the same function `lore export` calls, so what is copied
      // is what a chat product would receive rather than a second rendering of the same data.
      const response = await fetch('/v1/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request()),
      });
      if (!response.ok) throw new Error('The export could not be rendered.');
      const markdown = await response.text();
      await navigator.clipboard?.writeText(markdown);
      return markdown;
    },
    onSuccess: () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    },
  });

  const budgetError =
    budget.trim() !== '' &&
    (!Number.isInteger(Number(budget)) ||
      Number(budget) < BUDGET_MIN ||
      Number(budget) > BUDGET_MAX);

  return (
    <>
      <form
        className="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (task.trim() !== '' && !budgetError) run.mutate();
        }}
      >
        <label className="task-field">
          <span className="field-label">Task</span>
          <input
            type="text"
            className="task-input"
            placeholder="how do I roll back a release"
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
        </label>

        <label className="task-field task-field-narrow">
          <span className="field-label">Profile</span>
          <select
            className="task-select"
            value={profile}
            onChange={(event) => setProfile(event.target.value as Profile)}
          >
            {PROFILES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="task-field task-field-narrow">
          <span className="field-label">Budget</span>
          <input
            type="text"
            inputMode="numeric"
            className="task-input"
            placeholder="profile default"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            aria-invalid={budgetError}
            aria-describedby={budgetError ? 'budget-bounds' : undefined}
          />
        </label>

        <button type="submit" className="action" disabled={task.trim() === '' || budgetError}>
          Assemble
        </button>
      </form>

      {budgetError && (
        <p className="field-error prose" id="budget-bounds">
          {`A budget is a whole number between ${BUDGET_MIN.toLocaleString()} and ${BUDGET_MAX.toLocaleString()} estimated tokens.`}
        </p>
      )}

      {run.isPending && <Loading label="Assembling the bundle." />}
      {run.isError && <Failure {...toDisplayable(run.error)} />}

      {run.data !== undefined && (
        <>
          <Accounting bundle={run.data} />

          {/* The reserve, first, because that is where it is in the bundle and in what
              `lore export` writes. Leaving it off screen was #199: a reader saw nine of
              fifteen cited passages, and the ones withheld were the openings of the most
              relevant documents, so the passage that answered the task could be missing
              from a page whose whole purpose is showing what the model receives. */}
          {run.data.overview.length > 0 && (
            <div className="section">
              <h2 className="section-heading">orientation</h2>
              <p className="section-note prose">
                The opening of each of the most relevant documents, which is what the reserve in the
                budget above pays for. The model receives these alongside the selections.
              </p>
              <ItemList items={run.data.overview} />
            </div>
          )}

          <div className="section">
            <div className="section-with-action">
              <h2 className="section-heading">selected</h2>
              <button
                type="button"
                className="action"
                onClick={() => copyExport.mutate()}
                disabled={copyExport.isPending}
              >
                {copied ? 'Copied' : 'Copy as export'}
              </button>
            </div>
            {run.data.selected.length === 0 ? (
              <Empty title="Nothing fit. Every candidate is in the omissions below." />
            ) : (
              <ItemList items={run.data.selected} />
            )}
          </div>

          {/* Always empty until #76 builds table import. Rendered anyway, so a bundle section
              cannot be silently dropped a second time: the test below asserts every citation
              in the bundle is on the page, and a table that appeared here without a panel
              would fail it. */}
          {run.data.tables.length > 0 && (
            <div className="section">
              <h2 className="section-heading">tables</h2>
              <TableList tables={run.data.tables} />
            </div>
          )}

          {run.data.alternatives.length > 0 && (
            <div className="section">
              <h2 className="section-heading">alternatives</h2>
              {/* Architecture 13.4: these are ranked lower by declared hints. Lorepack does
                  not detect conflicts and does not decide which document is correct. */}
              <p className="section-note prose">
                Ranked lower by the status and authority declared in your configuration. Lorepack
                does not judge which of two documents is correct.
              </p>
              <ItemList items={run.data.alternatives} />
            </div>
          )}

          <Omissions items={run.data.omitted} />
        </>
      )}
    </>
  );
}

/**
 * Token accounting, architecture 13.6, labelled as estimates throughout.
 *
 * Every number here is a conservative estimate rather than a count, and saying so once at the
 * top is what stops a reader treating the arithmetic as exact.
 */
function Accounting({ bundle }: { readonly bundle: ContextBundle }): React.JSX.Element {
  const omittedByBudget = bundle.omitted
    .filter((item) => item.reason === 'budget')
    .reduce((sum, item) => sum + item.estimatedTokens, 0);

  return (
    <div className="section">
      <h2 className="section-heading">budget</h2>
      <p className="section-note prose">
        Every figure is a conservative estimate, not an exact token count.
      </p>
      <Facts>
        <Fact label="Profile">{bundle.profile}</Fact>
        <Fact label="Budget">{bundle.budget.toLocaleString()}</Fact>
        <Fact label="Used">{bundle.estimatedTokens.toLocaleString()}</Fact>
        {/* Named for what it bought, not just its size. "Reserved 468" beside "Selected 9"
            read as a budget line with nothing in it, because the passages it paid for were
            the ones missing from the page (#199). */}
        <Fact label="Orientation">
          {`${bundle.overview.length}, using ${bundle.reservedTokens.toLocaleString()} reserved`}
        </Fact>
        <Fact label="Selected">{String(bundle.selected.length)}</Fact>
        {bundle.alternatives.length > 0 && (
          <Fact label="Alternatives">{String(bundle.alternatives.length)}</Fact>
        )}
        {bundle.tables.length > 0 && <Fact label="Tables">{String(bundle.tables.length)}</Fact>}
        {/* The total a reader can check against the page: every passage the model receives
            carries a citation, so this is the number of items rendered above. */}
        <Fact label="Cited passages">{String(bundle.citations.length)}</Fact>
        <Fact label="Omitted">{String(bundle.omitted.length)}</Fact>
        {omittedByBudget > 0 && (
          <Fact label="Cut for budget">{omittedByBudget.toLocaleString()}</Fact>
        )}
      </Facts>
    </div>
  );
}

/**
 * The tables a bundle names, which is a name and an id and nothing more.
 *
 * A bundle references tables rather than embedding rows, so this is a list of what the model
 * was told exists. It stays a list until #76 gives a table something to show.
 */
function TableList({ tables }: { readonly tables: ContextBundle['tables'] }): React.JSX.Element {
  return (
    <ul className="items">
      {tables.map((table) => (
        <li key={table.tableId} className="item">
          <div className="item-head">
            <span className="table-name">{table.name}</span>
            <span className="table-id">{table.tableId}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ItemList({ items }: { readonly items: readonly ContextItem[] }): React.JSX.Element {
  return (
    <ul className="items">
      {items.map((item) => (
        <li key={item.chunkId} className="item">
          <div className="item-head">
            <Citation locator={item.locator} />
            <span className="item-tokens">{`${item.estimatedTokens.toLocaleString()} est`}</span>
            {item.labels.map((label) => (
              <Badge key={label} tone="idle">
                {label}
              </Badge>
            ))}
          </div>
          <p className="item-text prose">{item.text}</p>
        </li>
      ))}
    </ul>
  );
}

/** Why an item did not make it, in the reader's terms rather than as an enum value. */
const REASONS: Record<string, string> = {
  budget: 'did not fit the budget',
  duplicate: 'near-duplicate of something already selected',
  diversity: 'one document may not be the whole answer',
  superseded: 'superseded by another document you declared',
  archived: 'archived in your configuration',
  filtered: 'excluded by the filters on this request',
};

/**
 * Every omitted item, its category and its reason, at the same weight as the selections.
 *
 * This is the half of the route that makes it a debugger. "Why is this not in the answer" is
 * the question a person tuning retrieval arrives with.
 */
function Omissions({
  items,
}: {
  readonly items: readonly OmittedItem[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <div className="section">
      <h2 className="section-heading">omitted</h2>
      <table className="artifacts">
        <thead>
          <tr>
            <th scope="col">where</th>
            <th scope="col">why</th>
            <th scope="col" className="numeric">
              est
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.chunkId} className="artifact-row">
              <td>
                <Citation locator={item.locator} />
              </td>
              <td className="omitted-reason prose">{REASONS[item.reason] ?? item.reason}</td>
              <td className="numeric">{item.estimatedTokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Search, with the ranking breakdown this route exists to expose. */
function SearchTab(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const run = useMutation({ mutationFn: () => client.search({ query, debug: true }) });

  return (
    <>
      <form
        className="task-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim() !== '') run.mutate();
        }}
      >
        <label className="task-field">
          <span className="field-label">Query</span>
          <input
            type="search"
            className="task-input"
            placeholder="rollback"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" className="action" disabled={query.trim() === ''}>
          Search
        </button>
      </form>

      {run.isPending && <Loading label="Searching." />}
      {run.isError && <Failure {...toDisplayable(run.error)} />}

      {run.data !== undefined && (
        <div className="section">
          <p className="section-note prose">
            {`${run.data.hits.length} of ${run.data.totalIndexedChunks.toLocaleString()} indexed chunks. Relevance orders results and is not a measure of correctness or confidence.`}
          </p>
          {run.data.hits.length === 0 ? (
            <Empty title="No chunk matches those terms." />
          ) : (
            <ul className="items">
              {run.data.hits.map((hit) => (
                <li key={hit.chunkId} className="item">
                  <div className="item-head">
                    <Citation locator={hit.locator} />
                    <Badge tone="idle">{hit.status}</Badge>
                  </div>
                  <p className="item-text prose">{hit.excerpt}</p>
                  <ScoreBreakdown score={hit.score} components={hit.scoreComponents} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The score, as arithmetic rather than as a verdict.
 *
 * A bar, a gauge or a percentage reads as confidence whatever the caption says, so this is an
 * aligned table of the components that produced the number. It shows the **bounded** score
 * and never `lexicalRaw`: raw BM25 is not comparable across corpora (measured at 0.000002 on
 * repetitive text and 5.43 on varied prose), so a raw value on screen looks broken on exactly
 * the corpora people test with.
 */
function ScoreBreakdown({
  score,
  components,
}: {
  readonly score: number;
  readonly components: Readonly<Record<string, number>> | undefined;
}): React.JSX.Element {
  const shown = Object.entries(components ?? {}).filter(([name]) => name !== 'lexicalRaw');

  return (
    <details className="score">
      <summary className="score-summary">
        {`relevance ${score.toFixed(4)}`}
        <span className="score-hint"> ranking heuristic, not a truth score</span>
      </summary>
      {shown.length > 0 && (
        <dl className="score-components">
          {shown.map(([name, value]) => (
            <div key={name} className="score-row">
              <dt>{name}</dt>
              <dd>{value.toFixed(4)}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
