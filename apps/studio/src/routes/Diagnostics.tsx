import { useQuery } from '@tanstack/react-query';
import {
  Adjacent,
  Badge,
  Command,
  Fact,
  Facts,
  Failure,
  Loading,
  toneForCheck,
} from '../components/primitives.js';
import { toDisplayable } from '../lib/api.js';
import './Diagnostics.css';

/**
 * `lore doctor`, rendered, plus what only a running session knows.
 *
 * One check registry, two renderers. The checks are not reimplemented here: the server sends
 * the same report the CLI prints, validated against `schemas/doctor-report.json`, which was
 * published so that this route would render it rather than grow a second opinion about what
 * a healthy environment looks like.
 *
 * The amendment on #69 is a restraint brief, and it is right. A list of checks with pass,
 * warn or fail is a solved shape, and the value is entirely in the remediation being readable
 * and copyable. There is no health score, no dial and no percentage here, because an
 * environment is not 78 percent well: it has two things wrong with it, and each of them has
 * something concrete to do about it.
 */

type Status = 'pass' | 'warn' | 'fail';

interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly detail: string;
  readonly remediation?: string;
  readonly values?: Record<string, string | number | boolean>;
}

interface Report {
  readonly doctor: {
    readonly status: Status;
    readonly project: string | null;
    readonly checks: readonly Check[];
    readonly counts: { readonly pass: number; readonly warn: number; readonly fail: number };
  };
  readonly environment: Record<string, string | number | boolean>;
  readonly session: {
    readonly host: string;
    readonly port: number;
    readonly pid: number;
    readonly startedAt: string;
    readonly watcher: {
      readonly state: string;
      readonly watchedPaths: number;
      readonly lastEventAt: string | null;
      readonly lastRebuild: {
        readonly at: string;
        readonly durationMs: number;
        readonly created: boolean;
        readonly failed: boolean;
      } | null;
      readonly rebuilds: number;
      readonly noOps: number;
    } | null;
  };
  readonly clients: readonly {
    readonly id: string;
    readonly title: string;
    readonly installed: boolean;
    readonly version?: string;
    readonly supported: boolean;
    readonly configured: boolean;
    readonly ownedByLorepack: boolean;
    readonly configPath?: string;
    readonly reason?: string;
  }[];
}

export function Diagnostics(): React.JSX.Element {
  const report = useQuery({
    queryKey: ['diagnostics'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/diagnostics', { signal });
      const parsed = await response.json();
      if (!response.ok) throw parsed;
      return parsed as Report;
    },
    // The checks probe SQLite and touch the filesystem, so they run when a person asks for
    // them rather than on a timer.
    refetchOnWindowFocus: false,
  });

  if (report.isPending) return <Loading label="Running the checks." />;
  if (report.isError) {
    return (
      <section>
        <h1 className="route-title">Diagnostics</h1>
        <Failure {...toDisplayable(report.error)} />
      </section>
    );
  }

  const data = report.data;

  return (
    <section>
      <div className="route-header">
        <h1 className="route-title">Diagnostics</h1>
        <button
          type="button"
          className="action"
          disabled={report.isFetching}
          onClick={() => void report.refetch()}
        >
          {report.isFetching ? 'Running' : 'Re-run checks'}
        </button>
      </div>

      {/* Counted, never scored. "2 failed" is a number a person can act on; a percentage of
          checks passed is one they cannot. */}
      <p className="counts" role="status">
        {summarise(data.doctor.counts)}
      </p>

      <Checks checks={data.doctor.checks} />
      <Session session={data.session} />
      <Environment environment={data.environment} />
      <Clients clients={data.clients} />
    </section>
  );
}

function summarise(counts: { pass: number; warn: number; fail: number }): string {
  const parts = [`${counts.pass} passed`];
  if (counts.warn > 0) parts.push(`${counts.warn} to look at`);
  if (counts.fail > 0) parts.push(`${counts.fail} failed`);
  return parts.join(', ');
}

function Checks({ checks }: { readonly checks: readonly Check[] }): React.JSX.Element {
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.id} className="check">
          <div className="check-head">
            <Badge tone={toneForCheck(check.status)}>{check.status}</Badge>
            <span className="check-title">{check.title}</span>
          </div>
          <p className="check-detail prose">{check.detail}</p>
          {check.remediation !== undefined && (
            // Selectable and whole. These are things a person runs, and a remediation
            // truncated with an ellipsis is a remediation nobody can follow.
            <p className="check-remediation">{check.remediation}</p>
          )}
          {check.values !== undefined && Object.keys(check.values).length > 0 && (
            <dl className="check-values">
              {Object.entries(check.values).map(([key, value]) => (
                <div key={key} className="check-value">
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The running session, which is what a one-shot command cannot show.
 *
 * This is the block someone reads when something feels stuck, and every field answers a
 * version of one question: did it see my edit, and what did it do about it.
 */
function Session({ session }: { readonly session: Report['session'] }): React.JSX.Element {
  const watcher = session.watcher;

  return (
    <section className="panel">
      <h2 className="section-heading">Session</h2>
      <Facts>
        <Fact label="Address">{`${session.host}:${session.port}`}</Fact>
        <Fact label="Process">{String(session.pid)}</Fact>
        <Fact label="Started">{formatTime(session.startedAt)}</Fact>
        {watcher === null ? (
          <Fact label="Watcher" mono={false}>
            Not watching. This server serves the active build and never rebuilds.
          </Fact>
        ) : (
          <>
            <Fact label="Sources">{watcher.state}</Fact>
            <Fact label="Watching">{`${watcher.watchedPaths.toLocaleString()} paths`}</Fact>
            <Fact label="Last event">
              {watcher.lastEventAt === null ? 'none yet' : formatTime(watcher.lastEventAt)}
            </Fact>
            <Fact label="Last rebuild">{describeRebuild(watcher.lastRebuild)}</Fact>
            <Fact label="Rebuilds">{`${watcher.rebuilds}, and ${watcher.noOps} change${
              watcher.noOps === 1 ? '' : 's'
            } that changed nothing`}</Fact>
          </>
        )}
      </Facts>
    </section>
  );
}

function describeRebuild(
  rebuild: NonNullable<Report['session']['watcher']>['lastRebuild'],
): string {
  if (rebuild === null) return 'none since this session started';
  if (rebuild.failed) return `failed at ${formatTime(rebuild.at)}, after ${rebuild.durationMs} ms`;
  // A rebuild that produced nothing is a result, not a failure: identical content compiles to
  // an identical build id, which is the determinism invariant doing its job.
  const outcome = rebuild.created ? 'new build' : 'no change';
  return `${formatTime(rebuild.at)}, ${rebuild.durationMs} ms, ${outcome}`;
}

function Environment({
  environment,
}: {
  readonly environment: Report['environment'];
}): React.JSX.Element {
  return (
    <section className="panel">
      <h2 className="section-heading">Environment</h2>
      <Facts>
        {Object.entries(environment).map(([key, value]) => (
          <Fact key={key} label={key}>
            {String(value)}
          </Fact>
        ))}
      </Facts>
    </section>
  );
}

/**
 * Which clients are installed, and whether this project is wired into them.
 *
 * Paths and states only. No configuration file contents are shown, because those files hold
 * other people's servers and other people's credentials (section 15.6).
 */
function Clients({ clients }: { readonly clients: Report['clients'] }): React.JSX.Element {
  return (
    <section className="panel">
      <h2 className="section-heading">Clients</h2>
      <table className="clients">
        <thead>
          <tr>
            <th scope="col">client</th>
            <th scope="col">installed</th>
            <th scope="col">connected</th>
            <th scope="col">configuration</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((entry) => (
            <tr key={entry.id}>
              <th scope="row" className="client-name">
                {entry.version === undefined ? (
                  entry.title
                ) : (
                  <Adjacent lead={entry.title} className="client-version">
                    {entry.version}
                  </Adjacent>
                )}
              </th>
              <td>{entry.installed ? 'yes' : 'no'}</td>
              <td>{describeConnection(entry)}</td>
              <td className="client-path">{entry.configPath ?? '(none)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {clients.every((entry) => !entry.configured) && (
        <p className="clients-hint">
          <Command value="lore connect claude-code" />
        </p>
      )}
    </section>
  );
}

function describeConnection(entry: Report['clients'][number]): string {
  if (!entry.configured) return 'no';
  // The distinction that makes `lore disconnect` safe is worth showing here too: an entry
  // someone wrote by hand is theirs, and Lorepack says so rather than claiming credit.
  return entry.ownedByLorepack ? 'yes' : 'yes, configured by hand';
}

function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
