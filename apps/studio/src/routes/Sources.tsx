import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Citation } from '../components/Citation.js';
import { Equivalents } from '../components/Equivalents.js';
import {
  Adjacent,
  Badge,
  Empty,
  Fact,
  Facts,
  Failure,
  Loading,
  RouteHeader,
  toneForStatus,
} from '../components/primitives.js';
import { fetchSources, type SourceArtifact, toDisplayable } from '../lib/api.js';
import { type LineRange, readSourceEquivalents, serverOrigin } from '../lib/equivalents.js';
import { useHashParam } from '../lib/location.js';
import { type Exclusion, fetchWarnings, WARNINGS_KEY } from '../lib/warnings.js';
import './Sources.css';

/**
 * "Exactly what was parsed, and exactly what was not."
 *
 * The second half is the part that gets buried, and the amendment on #66 says it must not be:
 * a person opens this route to find out why their document is not in the build, and an
 * exclusion list collapsed at the bottom of the page is unreachable unless you already know
 * to look for it. So parsed and excluded are peers here, chosen with a control, rather than
 * a list and its appendix.
 */

type Artifact = SourceArtifact;

interface Excluded {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly class: string;
}

type View = 'indexed' | 'excluded';

const INTRO = 'Every file this build indexed, and every file it left out, with the reason.';

export function Sources(): React.JSX.Element {
  const [view, setView] = useState<View>('indexed');
  const [filter, setFilter] = useState('');
  // The command palette opens this route on one artifact with `?artifact=`.
  const linked = useHashParam('artifact');
  const linkedLines = useHashParam('lines');
  const [selected, setSelected] = useState<string | null>(linked);
  useEffect(() => {
    if (linked !== null) {
      setView('indexed');
      setSelected(linked);
    }
  }, [linked]);

  const sources = useQuery({ queryKey: ['sources'], queryFn: fetchSources });

  const excluded = useQuery({
    queryKey: WARNINGS_KEY,
    queryFn: fetchWarnings,
    select: (report) => ({
      discovered: report.groups.flatMap((group) =>
        group.warnings.map((warning): Excluded => ({ ...warning, class: group.class })),
      ),
      byRule: report.exclusions,
      byRuleCount: report.excludedByRule,
    }),
  });

  const artifacts = sources.data?.artifacts ?? [];
  const matching = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return artifacts;
    return artifacts.filter(
      (artifact) =>
        artifact.displayPath.toLowerCase().includes(needle) ||
        artifact.status.toLowerCase() === needle,
    );
  }, [artifacts, filter]);

  const detail = artifacts.find((artifact) => artifact.artifactId === selected) ?? null;

  if (sources.isPending) return <Loading label="Reading the artifact list." />;
  if (sources.isError) {
    return (
      <section>
        <RouteHeader title="Sources" intro={INTRO} />
        <Failure {...toDisplayable(sources.error)} />
      </section>
    );
  }

  // Everything the build left out, which is the two kinds together. The count on the control
  // read `excluded 1` while a rule had quietly removed a whole directory, because the control
  // counted warnings and called them exclusions (#202).
  const discovered = excluded.data?.discovered ?? [];
  const byRule = excluded.data?.byRule ?? null;
  const excludedCount = discovered.length + (excluded.data?.byRuleCount ?? 0);

  return (
    <section>
      <RouteHeader title="Sources" intro={INTRO} />

      {/* Indexed and excluded as peers. Choosing between them is one control, not an
          expansion, so neither is the other's footnote. */}
      <div className="sources-toolbar">
        {/* A fieldset rather than a div with `role="group"`: the semantic element carries
            the grouping to assistive technology without an ARIA attribute standing in for
            it, and a legend names the group properly. */}
        <fieldset className="view-switch">
          <legend className="visually-hidden">Which files to show</legend>
          <button
            type="button"
            className={view === 'indexed' ? 'view-option view-option-active' : 'view-option'}
            aria-pressed={view === 'indexed'}
            onClick={() => setView('indexed')}
          >
            {'indexed '}
            <span className="view-count">{artifacts.length}</span>
          </button>
          <button
            type="button"
            className={view === 'excluded' ? 'view-option view-option-active' : 'view-option'}
            aria-pressed={view === 'excluded'}
            onClick={() => setView('excluded')}
          >
            {'excluded '}
            <span className="view-count">{excludedCount}</span>
          </button>
        </fieldset>

        {view === 'indexed' && (
          <label className="filter">
            <span className="visually-hidden">Filter by path or status</span>
            <input
              type="search"
              className="field-control filter-input"
              placeholder="Filter by path or status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
        )}
      </div>

      {view === 'excluded' ? (
        <ExcludedList
          entries={discovered}
          byRule={byRule}
          loading={excluded.isPending}
          isError={excluded.isError}
        />
      ) : (
        <div className="sources-split">
          <ArtifactTable
            artifacts={matching}
            selected={selected}
            onSelect={setSelected}
            total={artifacts.length}
          />
          {detail === null ? (
            <p className="detail-hint prose">
              Choose a file to see its parser, size, node count and content hash.
            </p>
          ) : (
            <ArtifactDetail artifact={detail} />
          )}
        </div>
      )}

      {view === 'indexed' && detail !== null && (
        <SourceReader
          key={detail.artifactId}
          artifact={detail}
          range={linked === detail.artifactId ? parseLines(linkedLines) : null}
        />
      )}
    </section>
  );
}

/**
 * One row height, columns that align, and nothing per row that does not earn its place.
 *
 * At the 2,500-artifact envelope a row carrying an icon, a badge, a chevron and a menu stops
 * being a list and becomes noise, so status and authority are columns the eye scans rather
 * than decorations attached to each line.
 */
function ArtifactTable({
  artifacts,
  selected,
  onSelect,
  total,
}: {
  readonly artifacts: readonly Artifact[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly total: number;
}): React.JSX.Element {
  if (artifacts.length === 0) {
    return (
      <Empty title={total === 0 ? 'This build indexed no files.' : 'No file matches that filter.'}>
        {total === 0 && (
          <p>Check the exclusions, which list every file and the reason it was skipped.</p>
        )}
      </Empty>
    );
  }

  return (
    <div className="table-frame table-scroll">
      <table className="data-table artifacts">
        <caption className="visually-hidden">
          {`${artifacts.length} of ${total} indexed files`}
        </caption>
        <thead>
          <tr>
            <th scope="col">path</th>
            <th scope="col">status</th>
            <th scope="col" className="numeric">
              authority
            </th>
            <th scope="col" className="numeric">
              chunks
            </th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr
              key={artifact.artifactId}
              className={
                artifact.artifactId === selected
                  ? 'artifact-row artifact-row-selected'
                  : 'artifact-row'
              }
            >
              <td>
                <button
                  type="button"
                  className="artifact-path"
                  onClick={() => onSelect(artifact.artifactId)}
                >
                  {artifact.displayPath}
                </button>
              </td>
              <td>
                <Badge tone={toneForStatus(artifact.status)}>{artifact.status}</Badge>
              </td>
              <td className="numeric">{artifact.authority}</td>
              <td className="numeric">{artifact.chunkCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactDetail({ artifact }: { readonly artifact: Artifact }): React.JSX.Element {
  return (
    <aside className="artifact-detail" aria-label={`Details for ${artifact.displayPath}`}>
      {/* The file name as the title; the full path is in the citation right beneath it. */}
      <h2 className="detail-title">{artifact.displayPath.split('/').pop()}</h2>
      {/* The shared citation, so provenance looks the same here as it does in the Playground
          and in search results. */}
      <Citation
        locator={{ relativePath: artifact.displayPath, artifactId: artifact.artifactId }}
        link={false}
      />
      <Facts>
        {artifact.title !== null && (
          <Fact label="Title" mono={false}>
            {artifact.title}
          </Fact>
        )}
        <Fact label="Media type">{artifact.mediaType}</Fact>
        <Fact label="Parser">{artifact.parserId}</Fact>
        <Fact label="Size">{formatBytes(artifact.byteSize)}</Fact>
        <Fact label="Nodes">{artifact.nodeCount.toLocaleString()}</Fact>
        <Fact label="Chunks">{artifact.chunkCount.toLocaleString()}</Fact>
        <Fact label="Status">{artifact.status}</Fact>
        <Fact label="Authority">{String(artifact.authority)}</Fact>
        <Fact label="Content">{artifact.objectHash.slice(0, 16)}</Fact>
      </Facts>
    </aside>
  );
}

/**
 * Everything that is not in the build, and the exact reason, in the two shapes it comes in.
 *
 * Architecture 6.9 makes exclusion transparency a promise rather than a nicety: a document a
 * person believes is indexed and is not is the single most expensive way for this product to
 * be wrong, because every answer afterwards is confidently incomplete.
 *
 * This kept only half of that promise until #202. A file the walk read and could not parse
 * produces a warning and appeared here; a file an ignore rule removed produced nothing at
 * all, so the most common reason a document is missing was the one reason this view could
 * not show. The control said `excluded 1` while a rule had taken a whole directory.
 *
 * The two are kept as separate tables rather than merged into one list, because they are
 * different decisions taken at different moments: a rule decides before anything is read,
 * and a parser decides after. Merging them would need a column explaining which kind each
 * row was, which is the table above it.
 */
function ExcludedList({
  entries,
  byRule,
  loading,
  isError,
}: {
  readonly entries: readonly Excluded[];
  readonly byRule: readonly Exclusion[] | null;
  readonly loading: boolean;
  readonly isError: boolean;
}): React.JSX.Element {
  if (loading) return <Loading label="Reading exclusions." />;
  if (isError) {
    return <Empty title="This server does not report what was left out of the build." />;
  }
  if (entries.length === 0 && (byRule === null || byRule.length === 0)) {
    return (
      <Empty
        title={
          byRule === null
            ? 'Nothing was discovered and skipped. This build predates the record of what ignore rules removed.'
            : 'Nothing was excluded. Every file in scope is in this build.'
        }
      />
    );
  }

  return (
    <>
      {/* First, because it is the larger and quieter of the two. A rule written a little too
          broadly takes a whole folder out of every answer without producing a warning, and
          that is the case a person opens this view to find. */}
      {byRule !== null && byRule.length > 0 && (
        <div className="table-frame table-scroll excluded-block">
          <table className="data-table artifacts">
            <caption className="excluded-caption prose">
              Removed by an ignore rule before anything was read. Grouped by the rule, because one
              line of configuration is one decision however many files it covers.
            </caption>
            <thead>
              <tr>
                <th scope="col">rule</th>
                <th scope="col">from</th>
                <th scope="col" className="numeric">
                  paths
                </th>
                <th scope="col">for example</th>
              </tr>
            </thead>
            <tbody>
              {byRule.map((exclusion) => (
                <tr key={`${exclusion.source}-${exclusion.pattern}`} className="artifact-row">
                  <td className="excluded-path">{exclusion.pattern}</td>
                  <td className="excluded-source">{exclusion.source}</td>
                  <td className="numeric">{exclusion.count.toLocaleString()}</td>
                  <td className="excluded-sample">
                    <ul className="sample-list">
                      {sampleWorthShowing(exclusion).map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                      {exclusion.count > exclusion.sample.length && (
                        <li className="prose">
                          {`and ${(exclusion.count - exclusion.sample.length).toLocaleString()} more`}
                        </li>
                      )}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {byRule === null && (
        <p className="excluded-caption prose">
          This build predates the record of what ignore rules removed, so only files that were read
          and skipped are listed. Build again to record both.
        </p>
      )}

      {entries.length > 0 && (
        <div className="table-frame table-scroll excluded-block">
          <table className="data-table artifacts">
            <caption className="excluded-caption prose">
              Found by the walk and not indexed, each with the reason it was skipped.
            </caption>
            <thead>
              <tr>
                <th scope="col">path</th>
                <th scope="col">reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={`${entry.code}-${entry.path ?? ''}-${entry.message}`}
                  className="artifact-row"
                >
                  <td className="excluded-path">{entry.path ?? '(no path)'}</td>
                  <td>
                    <Adjacent
                      lead={entry.class}
                      leadClassName="excluded-class"
                      className="excluded-message prose"
                    >
                      {withoutPath(entry)}
                    </Adjacent>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The message without the path it already names, so the column does not stutter. */
function withoutPath(entry: Excluded): string {
  if (entry.path === undefined || !entry.message.startsWith(entry.path)) return entry.message;
  const rest = entry.message.slice(entry.path.length).trimStart();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} kB`;
  return `${Math.round(bytes / (1024 * 104.86)) / 10} MB`;
}

/**
 * The sample, minus anything that merely repeats the pattern.
 *
 * A pruned directory records itself as its own sample, so `drafts/` under the rule `drafts/`
 * is the same string twice: the row already says it. Dropping it keeps the column carrying
 * information rather than an echo, and it is why this is a render-time decision and not a
 * change to what discovery records: a rule written `node_modules` samples `node_modules/`,
 * which is genuinely a different string and worth showing.
 *
 * Only the rendered list is filtered. "and N more" still counts against the **whole** sample,
 * because the dropped entry was shown, in the row's own heading. Subtracting it there made a
 * pruned directory claim one hidden file that does not exist.
 */
function sampleWorthShowing(exclusion: { pattern: string; sample: readonly string[] }): string[] {
  const pattern = exclusion.pattern.replace(/\/$/, '');
  return exclusion.sample.filter((path) => path.replace(/\/$/, '') !== pattern);
}

/** `lines=11-13` from a citation link, or nothing when the parameter is absent or malformed. */
function parseLines(value: string | null): LineRange | null {
  const match = /^(\d+)-(\d+)$/.exec(value ?? '');
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

interface SourceRead {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * The text this build stored for one file, as `lore_read_source` returns it to a model.
 *
 * This is the answer to "what does my AI actually see of this document", which a file on
 * disk cannot give once it has changed since the build. A citation opens here with its
 * lines marked, so following provenance ends at the passage rather than at a file name.
 */
function SourceReader({
  artifact,
  range,
}: {
  readonly artifact: Artifact;
  readonly range: LineRange | null;
}): React.JSX.Element {
  const read = useQuery({
    queryKey: ['source', artifact.artifactId],
    queryFn: async ({ signal }): Promise<SourceRead> => {
      const response = await fetch(`/v1/sources/${encodeURIComponent(artifact.artifactId)}`, {
        signal,
      });
      const parsed = (await response.json()) as Partial<SourceRead>;
      if (!response.ok) throw parsed;
      if (typeof parsed.text !== 'string') throw new Error('This server cannot read a source.');
      return { text: parsed.text, truncated: parsed.truncated === true };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const frame = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);

  // A linked range is the reason the reader opened, so it is brought into view: the page to
  // the reader, and the reader to the first marked line.
  useEffect(() => {
    if (range === null || read.data === undefined) return;
    section.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const line = frame.current?.querySelector<HTMLElement>(`[data-line="${range.start}"]`);
    if (line !== null && line !== undefined && frame.current !== null) {
      frame.current.scrollTop = Math.max(line.offsetTop - 48, 0);
    }
  }, [range, read.data]);

  const lines = read.data?.text.split('\n') ?? [];

  return (
    <section className="reader" ref={section} aria-label={`Stored text of ${artifact.displayPath}`}>
      <div className="reader-head">
        <h2 className="reader-title">Stored text</h2>
        <p className="reader-note prose">
          {range === null
            ? 'Exactly what this build holds for the file, which is what a model reads.'
            : `Lines ${range.start}-${range.end} are the cited passage.`}
        </p>
      </div>
      {read.isPending ? (
        <Loading label="Reading the stored text." />
      ) : read.isError ? (
        <Failure {...toDisplayable(read.error)} />
      ) : (
        <>
          {/* Focusable, so a keyboard can scroll a long document (WCAG 2.1.1). */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus */}
          <div className="reader-frame" ref={frame} tabIndex={0}>
            <pre className="reader-text">
              {lines.map((line, index) => {
                const number = index + 1;
                const marked = range !== null && number >= range.start && number <= range.end;
                return (
                  // Lines are positions in an immutable text, so the number is the identity.
                  <span
                    key={number}
                    data-line={number}
                    className={marked ? 'reader-line reader-line-marked' : 'reader-line'}
                  >
                    <span className="reader-number" aria-hidden="true">
                      {number}
                    </span>
                    <span className="reader-content">{`${line}\n`}</span>
                  </span>
                );
              })}
            </pre>
          </div>
          {read.data.truncated && (
            <p className="reader-note prose">
              Truncated at the read limit, exactly as a model receives it. Read a line range to see
              the rest.
            </p>
          )}
          <Equivalents
            forms={readSourceEquivalents(artifact.artifactId, range, serverOrigin())}
            label="Read it anywhere"
          />
        </>
      )}
    </section>
  );
}
