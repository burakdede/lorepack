import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Command,
  Empty,
  Fact,
  Facts,
  Failure,
  Loading,
  toneForFreshness,
} from '../components/primitives.js';
import { client, toDisplayable } from '../lib/api.js';
import './Overview.css';

/**
 * "What is my AI seeing, is it current, and what would a rebuild change?"
 *
 * The one route where the generic instinct is strongest, and the amendment on #65 says why it
 * is wrong: artifact, node, chunk and table counts are exactly the shape of data that invites
 * four big numbers with delta arrows, and **these are facts about one immutable build, not
 * metrics trending over time.** There is no delta to show. A build either is what it is, or
 * it has been replaced by a different build with a different id.
 *
 * So the counts are an aligned key-value block echoing what `lore build` prints, and the
 * weight goes to source state, which is the only thing here that moves under the reader.
 */

interface Warning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface WarningGroup {
  readonly class: string;
  readonly count: number;
  readonly warnings: readonly Warning[];
}

export function Overview(): React.JSX.Element {
  const build = useQuery({
    queryKey: ['build'],
    queryFn: ({ signal }) => client.describeBuild(signal),
    refetchInterval: 2000,
  });

  if (build.isPending) return <Loading label="Reading the active build." />;

  if (build.isError) {
    const shown = toDisplayable(build.error);
    // A project with no build is not a failure to apologise for, it is the first thing a
    // person does. Everything else is a real failure and says so.
    if (shown.code === 'LORE_E_BUILD_NOT_FOUND') {
      return (
        <section>
          <h1 className="route-title">Overview</h1>
          <Empty title="This project has no build yet.">
            <p>Build it, and this page fills in.</p>
            <Command value="lore build" />
          </Empty>
        </section>
      );
    }
    return (
      <section>
        <h1 className="route-title">Overview</h1>
        <Failure {...shown} />
      </section>
    );
  }

  const data = build.data;
  const dirty = data.sourceState === 'dirty';

  return (
    <section>
      <h1 className="route-title">Overview</h1>

      {/* Source state first, and given the weight. It is the question this route exists to
          answer and the only value on it that changes without the reader acting. */}
      <div className={dirty ? 'state-banner state-banner-dirty' : 'state-banner'}>
        <Badge tone={toneForFreshness(data.sourceState)}>{data.sourceState}</Badge>
        <p className="state-line prose">
          {data.sourceState === 'clean'
            ? 'The sources match this build. Your AI is reading what is on disk.'
            : data.sourceState === 'dirty'
              ? 'The sources have changed since this build. Your AI is reading the older text.'
              : 'Freshness could not be established, so this build is served as it is.'}
        </p>
        {dirty && <Command value="lore build" />}
      </div>

      <div className="section">
        <h2 className="section-heading">build</h2>
        <Facts>
          <Fact label="Project">{data.projectName}</Fact>
          <Fact label="Build">
            <BuildId full={data.buildId} short={data.shortBuildId} />
          </Fact>
          <Fact label="Created">{new Date(data.createdAt).toLocaleString()}</Fact>
          <Fact label="Artifacts">{data.counts.artifacts.toLocaleString()}</Fact>
          <Fact label="Nodes">{data.counts.nodes.toLocaleString()}</Fact>
          <Fact label="Chunks">{data.counts.chunks.toLocaleString()}</Fact>
          {data.counts.tables > 0 && (
            <Fact label="Tables">
              {`${data.counts.tables.toLocaleString()} (${data.counts.tableRows.toLocaleString()} rows)`}
            </Fact>
          )}
          <Fact label="Capabilities">{data.capabilities.join(' ')}</Fact>
          <Fact label="Compiler">{data.compilerVersion}</Fact>
        </Facts>
      </div>

      <Warnings count={data.warningCount} />
      <PlanPanel />
    </section>
  );
}

/** Short for reading, full for citing. The full id is what a bug report needs. */
function BuildId({
  full,
  short,
}: {
  readonly full: string;
  readonly short: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <span className="build-id">
      <span title={full}>{short}</span>
      <button
        type="button"
        className="command-copy"
        aria-label={`Copy build id ${full}`}
        onClick={() => {
          void navigator.clipboard?.writeText(full).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

function Warnings({ count }: { readonly count: number }): React.JSX.Element | null {
  const warnings = useQuery({
    queryKey: ['warnings'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/warnings', { signal });
      if (!response.ok) throw new Error('Warnings are not available from this server.');
      return (await response.json()) as { total: number; groups: readonly WarningGroup[] };
    },
    // Nothing to fetch when the build recorded none, which is the common case.
    enabled: count > 0,
  });

  if (count === 0) return null;

  return (
    <div className="section">
      <h2 className="section-heading">warnings</h2>
      {warnings.data === undefined ? (
        <Loading label="Reading warnings." />
      ) : (
        <ul className="warning-groups">
          {warnings.data.groups.map((group) => (
            <li key={group.class} className="warning-group">
              <span className="warning-count">{group.count}</span>
              <span className="warning-class">{group.class}</span>
              <ul className="warning-list">
                {group.warnings.slice(0, 5).map((warning) => (
                  <li key={`${warning.code}-${warning.path ?? ''}-${warning.message}`}>
                    {warning.path !== undefined && (
                      <span className="warning-path">{warning.path}</span>
                    )}
                    <span className="warning-message prose">{withoutPath(warning)}</span>
                  </li>
                ))}
                {group.warnings.length > 5 && (
                  <li className="warning-more prose">
                    {`and ${group.warnings.length - 5} more, in lore inspect warnings`}
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The message without the path it already names.
 *
 * Warnings are written as complete sentences for the CLI, where there is no column to put a
 * path in, so most begin with one. Showing the path in its own column and then again at the
 * start of the sentence reads as a stutter, which is what it was doing.
 */
function withoutPath(warning: Warning): string {
  if (warning.path === undefined || !warning.message.startsWith(warning.path)) {
    return warning.message;
  }
  const rest = warning.message.slice(warning.path.length).trimStart();
  // Recapitalised, because what is left used to be the middle of a sentence.
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * What a rebuild would change, on demand.
 *
 * Deliberately not polled. Planning walks and fingerprints the whole corpus, and doing that
 * every few seconds to keep a panel warm would make the inspector the most expensive thing
 * running on the machine.
 */
function PlanPanel(): React.JSX.Element {
  const [asked, setAsked] = useState(false);
  const plan = useQuery({
    queryKey: ['plan'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/plan', { signal });
      if (!response.ok) throw new Error('This server cannot plan, because it has no sources.');
      return (await response.json()) as {
        artifacts: { added: number; changed: number; removed: number; reused: number };
        lock: { changed: boolean };
      };
    },
    enabled: asked,
    staleTime: 0,
  });

  return (
    <div className="section">
      <h2 className="section-heading">next build</h2>
      {!asked ? (
        <div className="plan-idle">
          <p className="prose">Planning reads every source file, so it runs when you ask.</p>
          <button type="button" className="action" onClick={() => setAsked(true)}>
            Plan a rebuild
          </button>
        </div>
      ) : plan.isPending ? (
        <Loading label="Planning. This reads every source file." />
      ) : plan.isError ? (
        <Failure {...toDisplayable(plan.error)} />
      ) : (
        <>
          <Facts>
            <Fact label="Added">{plan.data.artifacts.added.toLocaleString()}</Fact>
            <Fact label="Changed">{plan.data.artifacts.changed.toLocaleString()}</Fact>
            <Fact label="Removed">{plan.data.artifacts.removed.toLocaleString()}</Fact>
            <Fact label="Reused">{plan.data.artifacts.reused.toLocaleString()}</Fact>
            <Fact label="Lockfile" mono={false}>
              {plan.data.lock.changed ? 'would change' : 'unchanged'}
            </Fact>
          </Facts>
          <div className="plan-refresh">
            <button type="button" className="action" onClick={() => void plan.refetch()}>
              Plan again
            </button>
          </div>
        </>
      )}
    </div>
  );
}
