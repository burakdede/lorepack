import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Citation } from '../components/Citation.js';
import {
  Badge,
  Empty,
  Fact,
  Facts,
  Failure,
  Loading,
  toneForStatus,
} from '../components/primitives.js';
import { toDisplayable } from '../lib/api.js';
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

interface Artifact {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly displayPath: string;
  readonly title: string | null;
  readonly status: string;
  readonly authority: number;
  readonly mediaType: string;
  readonly objectHash: string;
  readonly byteSize: number;
  readonly parserId: string;
  readonly chunkCount: number;
  readonly nodeCount: number;
}

interface Excluded {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly class: string;
}

type View = 'indexed' | 'excluded';

export function Sources(): React.JSX.Element {
  const [view, setView] = useState<View>('indexed');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/sources', { signal });
      if (!response.ok) throw new Error('This server does not list sources.');
      return (await response.json()) as { buildId: string; artifacts: readonly Artifact[] };
    },
  });

  const excluded = useQuery({
    queryKey: ['warnings'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/warnings', { signal });
      if (!response.ok) throw new Error('This server does not report warnings.');
      const body = (await response.json()) as {
        groups: readonly { class: string; warnings: readonly Excluded[] }[];
      };
      return body.groups.flatMap((group) =>
        group.warnings.map((w) => ({ ...w, class: group.class })),
      );
    },
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
        <h1 className="route-title">Sources</h1>
        <Failure {...toDisplayable(sources.error)} />
      </section>
    );
  }

  const excludedCount = excluded.data?.length ?? 0;

  return (
    <section>
      <h1 className="route-title">Sources</h1>

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
            {`indexed ${artifacts.length}`}
          </button>
          <button
            type="button"
            className={view === 'excluded' ? 'view-option view-option-active' : 'view-option'}
            aria-pressed={view === 'excluded'}
            onClick={() => setView('excluded')}
          >
            {`excluded ${excludedCount}`}
          </button>
        </fieldset>

        {view === 'indexed' && (
          <label className="filter">
            <span className="visually-hidden">Filter by path or status</span>
            <input
              type="search"
              className="filter-input"
              placeholder="path or status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
        )}
      </div>

      {view === 'excluded' ? (
        <ExcludedList entries={excluded.data ?? []} loading={excluded.isPending} />
      ) : (
        <div className="sources-split">
          <ArtifactTable
            artifacts={matching}
            selected={selected}
            onSelect={setSelected}
            total={artifacts.length}
          />
          {detail !== null && <ArtifactDetail artifact={detail} />}
        </div>
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
    <table className="artifacts">
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
  );
}

function ArtifactDetail({ artifact }: { readonly artifact: Artifact }): React.JSX.Element {
  return (
    <aside className="artifact-detail" aria-label={`Details for ${artifact.displayPath}`}>
      <h2 className="section-heading">{artifact.displayPath}</h2>
      {/* The shared citation, so provenance looks the same here as it does in the Playground
          and in search results. */}
      <Citation locator={{ relativePath: artifact.displayPath, artifactId: artifact.artifactId }} />
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
 * Every file that is not in the build, and the exact reason.
 *
 * Architecture 6.9 makes exclusion transparency a promise rather than a nicety: a document a
 * person believes is indexed and is not is the single most expensive way for this product to
 * be wrong, because every answer afterwards is confidently incomplete.
 */
function ExcludedList({
  entries,
  loading,
}: {
  readonly entries: readonly Excluded[];
  readonly loading: boolean;
}): React.JSX.Element {
  if (loading) return <Loading label="Reading exclusions." />;
  if (entries.length === 0) {
    return <Empty title="Nothing was excluded. Every file in scope is in this build." />;
  }

  return (
    <table className="artifacts">
      <thead>
        <tr>
          <th scope="col">path</th>
          <th scope="col">reason</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={`${entry.code}-${entry.path ?? ''}-${entry.message}`} className="artifact-row">
            <td className="excluded-path">{entry.path ?? '(no path)'}</td>
            <td>
              <span className="excluded-class">{entry.class}</span>
              <span className="excluded-message prose">{withoutPath(entry)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
