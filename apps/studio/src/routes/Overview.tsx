import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Adjacent,
  Badge,
  Command,
  CopyValue,
  Empty,
  Fact,
  Facts,
  Failure,
  Loading,
  RouteHeader,
  toneForFreshness,
} from '../components/primitives.js';
import { client, toDisplayable } from '../lib/api.js';
import { type Client, fetchDiagnostics } from '../lib/diagnostics.js';
import { serverOrigin } from '../lib/equivalents.js';
import { fetchWarnings, WARNINGS_KEY, type Warning } from '../lib/warnings.js';
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

const INTRO = 'The build your AI reads right now, and whether its sources still match it.';

export function Overview(): React.JSX.Element {
  // Lifted, so the "plan the next build" step and the panel's own button are one action.
  const [planAsked, setPlanAsked] = useState(false);
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
          <RouteHeader title="Overview" intro={INTRO} />
          <Empty title="This project has no build yet.">
            <p>Build it, and this page fills in.</p>
            <Command value="lore build" />
          </Empty>
        </section>
      );
    }
    return (
      <section>
        <RouteHeader title="Overview" intro={INTRO} />
        <Failure {...shown} />
      </section>
    );
  }

  const data = build.data;
  const dirty = data.sourceState === 'dirty';

  return (
    <section>
      <RouteHeader title="Overview" intro={INTRO} />

      {/* The build, and whether its sources still match it. Freshness leads the panel
          because it is the question this route exists to answer and the only value here that
          changes without the reader acting. */}
      <div className={dirty ? 'panel summary summary-dirty' : 'panel summary'}>
        <h2 className="visually-hidden">build</h2>
        <div className="summary-id">
          <BuildId full={data.buildId} short={data.shortBuildId} />
        </div>
        <div className="state-banner">
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
        <p className="summary-meta">
          {data.createdAt !== undefined && (
            <span>{`Created ${new Date(data.createdAt).toLocaleString()}`}</span>
          )}
          <span>{`Compiler ${data.compilerVersion}`}</span>
          <span className="capabilities">
            {data.capabilities.map((capability, index) => (
              <span key={capability}>
                {index > 0 && ' '}
                <span className="capability">{capability}</span>
              </span>
            ))}
          </span>
        </p>
      </div>

      <NextSteps
        onPlan={() => {
          setPlanAsked(true);
          focusPanel('next-build');
        }}
      />

      <div className="overview-grid">
        <div className="overview-main">
          <ConnectPanel />
          <div className="panel overview-build">
            <h2 className="section-heading">contents</h2>
            <Facts>
              <Fact label="Project">{data.projectName}</Fact>
              <Fact label="Artifacts">{data.counts.artifacts.toLocaleString()}</Fact>
              <Fact label="Nodes">{data.counts.nodes.toLocaleString()}</Fact>
              <Fact label="Chunks">{data.counts.chunks.toLocaleString()}</Fact>
              {data.counts.tables > 0 && (
                <Fact label="Tables">
                  {`${data.counts.tables.toLocaleString()} (${data.counts.tableRows.toLocaleString()} rows)`}
                </Fact>
              )}
            </Facts>
          </div>
        </div>

        <div className="overview-side">
          <PlanPanel asked={planAsked} onAsk={() => setPlanAsked(true)} />
          <Warnings count={data.warningCount} />
        </div>
      </div>
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
    queryKey: WARNINGS_KEY,
    queryFn: fetchWarnings,
    // Nothing to fetch when the build recorded none, which is the common case.
    enabled: count > 0,
  });

  if (count === 0) return null;

  return (
    <div className="panel">
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
                    {warning.path === undefined ? (
                      <span className="warning-message prose">{withoutPath(warning)}</span>
                    ) : (
                      // A path is the thing a reader copies out of a warning to go and look
                      // at the file, so it has to survive being copied (#203).
                      <Adjacent
                        lead={warning.path}
                        leadClassName="warning-path"
                        className="warning-message prose"
                      >
                        {withoutPath(warning)}
                      </Adjacent>
                    )}
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
function PlanPanel({
  asked,
  onAsk,
}: {
  readonly asked: boolean;
  readonly onAsk: () => void;
}): React.JSX.Element {
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
    <div className="panel" id="next-build" tabIndex={-1}>
      <h2 className="section-heading">next build</h2>
      {!asked ? (
        <div className="plan-idle">
          <p className="prose">Planning reads every source file, so it runs when you ask.</p>
          <button type="button" className="action" onClick={onAsk}>
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

/** Moves focus to a panel, so a step that points somewhere also takes a keyboard there. */
function focusPanel(id: string): void {
  window.requestAnimationFrame(() => {
    const target = document.getElementById(id);
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  });
}

/**
 * The client list, from the doctor report.
 *
 * Read defensively: a server too old to report clients answers without the field, and the
 * panel then says nothing is detected rather than failing the whole route.
 */
function useClients(): { readonly clients: readonly Client[]; readonly pending: boolean } {
  const report = useQuery({
    queryKey: ['diagnostics'],
    queryFn: fetchDiagnostics,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const clients = Array.isArray(report.data?.clients) ? report.data.clients : [];
  return { clients, pending: report.isPending };
}

/**
 * Three things a developer does after `lore dev`, each one action away. Live where the state
 * is knowable: the connect step says how many clients already read this build.
 */
function NextSteps({ onPlan }: { readonly onPlan: () => void }): React.JSX.Element {
  const { clients, pending } = useClients();
  const connected = clients.filter((client) => client.configured).length;

  return (
    <section className="next-steps" aria-label="Next steps">
      <div className="next-step">
        <h2 className="next-step-title">Ask the build a question</h2>
        <p className="next-step-text prose">
          Assemble the context a model would receive for a task, then copy it as a CLI, HTTP or MCP
          call.
        </p>
        <a className="action action-small" href="#/playground">
          Open Playground
        </a>
      </div>
      <div className="next-step">
        <h2 className="next-step-title">
          {'Connect an AI client '}
          {!pending && (
            <Badge tone={connected > 0 ? 'ok' : 'idle'}>
              {connected > 0 ? `${connected} connected` : 'none connected'}
            </Badge>
          )}
        </h2>
        <p className="next-step-text prose">
          Point an MCP client at this build. It reads, and can never build, deploy or edit.
        </p>
        <button type="button" className="action action-small" onClick={() => focusPanel('connect')}>
          Show how to connect
        </button>
      </div>
      <div className="next-step">
        <h2 className="next-step-title">Preview the next build</h2>
        <p className="next-step-text prose">
          See what a rebuild would add, change or remove before anything is compiled.
        </p>
        <button type="button" className="action action-small" onClick={onPlan}>
          Preview a rebuild
        </button>
      </div>
    </section>
  );
}

/**
 * Everything needed to point a client at this build: the endpoints this process serves, and
 * the one command per installed client that wires it up.
 *
 * Studio shows the commands and never runs them. `lore connect` edits a client's own
 * configuration, which is the user's to approve in a terminal, not a browser's to do.
 */
function ConnectPanel(): React.JSX.Element {
  const origin = serverOrigin();
  const { clients, pending } = useClients();
  const toWire = clients.filter((client) => client.installed && !client.configured);

  return (
    <div className="panel connect" id="connect" tabIndex={-1}>
      <h2 className="section-heading">connect your AI</h2>
      <p className="section-note prose">
        This process serves the active build read-only, over MCP and HTTP, on the address Studio is
        open at.
      </p>
      <dl className="endpoints">
        <div className="endpoint">
          <dt>MCP over HTTP</dt>
          <dd>
            <CopyValue value={`${origin}/mcp`} label="MCP endpoint" />
          </dd>
        </div>
        <div className="endpoint">
          <dt>MCP over stdio</dt>
          <dd>
            <Command value="lore mcp" />
          </dd>
        </div>
        <div className="endpoint">
          <dt>HTTP API</dt>
          <dd>
            <CopyValue value={`${origin}/v1`} label="HTTP API base URL" />
          </dd>
        </div>
      </dl>

      <h3 className="connect-heading">Clients on this machine</h3>
      {pending ? (
        <Loading label="Looking for installed clients." />
      ) : clients.length === 0 ? (
        <p className="connect-none prose">
          No supported client was detected. Any MCP client can use the endpoints above.
        </p>
      ) : (
        <ul className="client-list">
          {clients.map((entry) => (
            <li key={entry.id} className="client-row">
              <span className="client-row-name">
                {entry.version === undefined ? (
                  entry.title
                ) : (
                  <Adjacent lead={entry.title} className="client-row-version">
                    {entry.version}
                  </Adjacent>
                )}
              </span>
              <Badge tone={entry.configured ? 'ok' : 'idle'}>
                {entry.installed
                  ? entry.configured
                    ? 'connected'
                    : 'not connected'
                  : 'not installed'}
              </Badge>
              {entry.configured && !entry.ownedByLorepack && (
                // Someone wrote this entry by hand, so it is theirs; `lore disconnect` leaves it.
                <span className="client-row-note">configured by hand</span>
              )}
              {toWire.includes(entry) && (
                <span className="client-row-command">
                  <Command value={`lore connect ${entry.id}`} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
