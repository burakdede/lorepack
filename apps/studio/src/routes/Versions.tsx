import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge, Empty, Failure, Loading } from '../components/primitives.js';
import { toDisplayable } from '../lib/api.js';
import './Versions.css';

/**
 * Versions: the lifecycle, made visible.
 *
 * This route holds every action in the product that changes anything, and section 15.6 asks
 * each of them to show a plan and be confirmed. So a confirmation here is a designed surface
 * rather than a browser dialog: it names the build, shows the same comparison `lore diff`
 * would print, and puts the verb on the button. The verb survives into the result, so
 * "Activate" produces "Activated" and a person can tell which action finished.
 *
 * Nothing here is styled as dangerous. Activation and rollback are pointer changes that never
 * recompile (section 18.4), the previous build stays exactly where it was, and red styling
 * would tell the reader something untrue about what they are about to do.
 */

interface Build {
  readonly buildId: string;
  readonly createdAt: string;
  readonly state: string;
  readonly active: boolean;
  readonly counts: {
    readonly artifacts: number;
    readonly nodes: number;
    readonly chunks: number;
    readonly tables: number;
    readonly tableRows: number;
  };
  readonly capabilities: readonly string[] | null;
}

interface History {
  readonly activeBuildId: string | null;
  readonly builds: readonly Build[];
}

interface Diff {
  readonly from: string;
  readonly to: string;
  readonly identical: boolean;
  readonly incompatibilities: readonly { field: string; from: string; to: string }[];
  readonly artifacts: {
    readonly changes: readonly {
      path: string;
      change: 'added' | 'changed' | 'removed';
      sameContentAs?: string;
    }[];
  };
  readonly rules: readonly {
    path: string;
    field: string;
    from: string | null;
    to: string | null;
  }[];
  readonly chunks: { readonly added: number; readonly changed: number; readonly removed: number };
  readonly tables: readonly {
    tableId: string;
    name: string;
    rowsBefore: number | null;
    rowsAfter: number | null;
    columnsAdded: readonly string[];
    columnsRemoved: readonly string[];
  }[];
  readonly capabilities: readonly { capability: string; change: 'same' | 'added' | 'removed' }[];
}

/** An action a person has asked for and not yet confirmed. */
type Pending = {
  readonly kind: 'activate' | 'rollback' | 'pack';
  readonly build: string;
};

/**
 * One verb per action, in both tenses it is read in.
 *
 * Buttons and results take their words from here so they cannot drift apart. A button
 * reading "Activate" produces a result reading "Activated", which is how a person knows the
 * message belongs to the thing they pressed.
 */
const VERBS = {
  activate: { imperative: 'Activate', past: 'Activated' },
  rollback: { imperative: 'Roll back to', past: 'Rolled back to' },
  pack: { imperative: 'Pack', past: 'Packed' },
} as const;

export function Versions(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ from: string; to: string } | null>(null);

  const history = useQuery({
    queryKey: ['builds'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/v1/builds', { signal });
      if (!response.ok) throw new Error('This server does not manage builds.');
      return (await response.json()) as History;
    },
  });

  const act = useMutation({
    mutationFn: async (action: Pending) => {
      const response = await fetch(endpointFor(action), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyFor(action)),
      });
      const parsed = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw parsed;
      return { action, result: parsed };
    },
    onSuccess: async ({ action, result }) => {
      setPending(null);
      setOutcome(describeOutcome(action, result));
      // Both the header's build and this list may have moved, so everything is refetched
      // rather than patched. An inspector showing a build that is no longer active is the
      // one failure this route cannot afford.
      await queryClient.invalidateQueries();
    },
  });

  if (history.isPending) return <Loading label="Reading build history." />;
  if (history.isError) {
    return (
      <section>
        <h1 className="route-title">Versions</h1>
        <Failure {...toDisplayable(history.error)} />
      </section>
    );
  }

  const builds = history.data?.builds ?? [];
  const active = history.data?.activeBuildId ?? null;
  const rollbackTarget = previousBuild(builds, active);

  const start = (action: Pending): void => {
    setOutcome(null);
    setPending(action);
  };

  return (
    <section>
      <h1 className="route-title">Versions</h1>

      {outcome !== null && (
        <p className="outcome" role="status">
          {outcome}
        </p>
      )}
      {act.isError && <Failure {...toDisplayable(act.error)} />}

      {builds.length === 0 ? (
        <Empty title="This project has no builds yet.">
          <p>Run a build, and every version of it appears here.</p>
        </Empty>
      ) : (
        <>
          <BuildTable
            builds={builds}
            busy={act.isPending}
            onAct={start}
            onCompare={(buildId) => {
              // One comparison on screen at a time. A confirmation is itself a diff, and two
              // of them, in two directions, is a page nobody can read.
              setPending(null);
              setCompare({ from: buildId, to: active ?? builds[0]?.buildId ?? buildId });
            }}
          />

          {rollbackTarget !== null && (
            <p className="rollback-line">
              <button
                type="button"
                className="action"
                disabled={act.isPending}
                onClick={() => start({ kind: 'rollback', build: rollbackTarget })}
              >
                Roll back
              </button>
              <span className="prose">
                Returns to the previous verified build. A pointer change, so nothing is recompiled
                and this build stays exactly where it is.
              </span>
            </p>
          )}
        </>
      )}

      {pending !== null && (
        <Confirmation
          pending={pending}
          active={active}
          busy={act.isPending}
          onCancel={() => setPending(null)}
          onConfirm={() => act.mutate(pending)}
        />
      )}

      {builds.length > 1 && pending === null && (
        <Compare builds={builds} selection={compare} onSelect={setCompare} active={active} />
      )}
    </section>
  );
}

/**
 * The history, as a table.
 *
 * A card per build would give every version the visual weight of a headline and stop the
 * columns lining up, which is the one thing that makes twenty builds readable at a glance.
 */
function BuildTable({
  builds,
  busy,
  onAct,
  onCompare,
}: {
  readonly builds: readonly Build[];
  readonly busy: boolean;
  readonly onAct: (action: Pending) => void;
  readonly onCompare: (buildId: string) => void;
}): React.JSX.Element {
  return (
    // The table scrolls inside its own box rather than pushing the page sideways. At 200%
    // zoom a build id, a timestamp and three actions do not fit on one line however the
    // columns are trimmed, and a page that scrolls horizontally loses the navigation too.
    <div className="table-scroll">
      <table className="builds">
        <caption className="visually-hidden">Every build in this project, newest first</caption>
        <thead>
          <tr>
            <th scope="col">build</th>
            <th scope="col">created</th>
            <th scope="col">state</th>
            <th scope="col" className="numeric">
              artifacts
            </th>
            <th scope="col" className="numeric">
              chunks
            </th>
            <th scope="col">capabilities</th>
            <th scope="col">deployment</th>
            <th scope="col">
              <span className="visually-hidden">actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {builds.map((build) => (
            <tr
              key={build.buildId}
              className={build.active ? 'build-row build-row-active' : 'build-row'}
            >
              <th scope="row" className="build-id">
                {/* A word, not only a row tint: which build is live is the most important fact
                  on this page, and a tint alone does not survive greyscale. */}
                {build.active && <span className="active-marker">active</span>}
                <span title={build.buildId}>{shorten(build.buildId)}</span>
              </th>
              <td className="build-created">{formatTime(build.createdAt)}</td>
              <td>
                <Badge tone={toneForBuildState(build.state)}>{build.state}</Badge>
              </td>
              <td className="numeric">{build.counts.artifacts.toLocaleString()}</td>
              <td className="numeric">{build.counts.chunks.toLocaleString()}</td>
              <td className="build-capabilities">
                {build.capabilities === null ? 'unknown' : build.capabilities.join(' ')}
              </td>
              {/* Phase 6 fills this in. Stating "local only" now is accurate, and keeps the
                column from appearing out of nowhere when remote targets arrive. */}
              <td className="build-deployment">local only</td>
              <td className="build-actions">
                <button
                  type="button"
                  className="action"
                  onClick={() => onCompare(build.buildId)}
                  aria-label={`Compare ${shorten(build.buildId)}`}
                >
                  Compare
                </button>
                {!build.active && isActivatable(build.state) && (
                  <button
                    type="button"
                    className="action"
                    disabled={busy}
                    aria-label={`Activate ${shorten(build.buildId)}`}
                    onClick={() => onAct({ kind: 'activate', build: build.buildId })}
                  >
                    Activate
                  </button>
                )}
                {/* Only a build that passed validation can be packed, so a button that would
                  always fail is not offered. */}
                {isActivatable(build.state) && (
                  <button
                    type="button"
                    className="action"
                    disabled={busy}
                    aria-label={`Pack ${shorten(build.buildId)}`}
                    onClick={() => onAct({ kind: 'pack', build: build.buildId })}
                  >
                    Pack
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The plan, and the button that carries it out.
 *
 * Inline rather than an overlay. The plan for an activation is a real comparison and wants
 * room, and dimming the history a person is reading it against helps nobody. Focus moves
 * here when it opens, which is the part of a modal that was worth keeping.
 */
function Confirmation({
  pending,
  active,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly pending: Pending;
  readonly active: string | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const verb = VERBS[pending.kind].imperative;
  const label = `${verb} ${shorten(pending.build)}`;

  return (
    // The key handler is on the container so Escape closes this from anywhere inside it.
    // Every control within is a real button and independently operable, so nothing here
    // depends on the container being interactive.
    <section
      className="confirm"
      aria-labelledby="confirm-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      {/* Focusable so opening the panel lands the reader on it rather than leaving them at
          the button they pressed, six rows up. */}
      <h2 className="section-heading" id="confirm-heading" ref={heading} tabIndex={-1}>
        {label}
      </h2>

      {pending.kind === 'pack' ? (
        <p className="prose confirm-plan">
          Writes a <code>.lorepack</code> archive of this build into the project root. Nothing about
          the build changes, and the archive is an ordinary ZIP that opens without Lorepack.
        </p>
      ) : (
        <ActivationPlan from={active} to={pending.build} />
      )}

      <div className="confirm-actions">
        {/* The verb and the build, not "Confirm". A person who reads only this button should
            know exactly what is about to happen and to which build. */}
        <button type="button" className="action action-primary" disabled={busy} onClick={onConfirm}>
          {label}
        </button>
        <button type="button" className="action" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * What changes if this build becomes the live one.
 *
 * A real comparison, fetched for exactly this pair, rather than a sentence promising the
 * reader that something will change. Identical builds say so, and the action stays available,
 * because activating a build identical to the live one is harmless.
 */
function ActivationPlan({
  from,
  to,
}: {
  readonly from: string | null;
  readonly to: string;
}): React.JSX.Element {
  const diff = useDiff(from ?? '', to, from !== null && from !== to);

  if (from === null) {
    return <p className="prose confirm-plan">No build is active, so this one becomes the first.</p>;
  }

  return (
    <div className="confirm-plan">
      <p className="prose">
        {`Serving moves from ${shorten(from)} to ${shorten(to)}. Nothing is recompiled, and ${shorten(from)} stays exactly where it is.`}
      </p>
      {diff.isPending && from !== to && <Loading label="Comparing the two builds." />}
      {diff.isError && <Failure {...toDisplayable(diff.error)} />}
      {diff.data !== undefined && <DiffBody diff={diff.data} />}
    </div>
  );
}

/** Choosing any two builds, which is what makes this a comparison rather than a release log. */
function Compare({
  builds,
  selection,
  onSelect,
  active,
}: {
  readonly builds: readonly Build[];
  readonly selection: { from: string; to: string } | null;
  readonly onSelect: (selection: { from: string; to: string }) => void;
  readonly active: string | null;
}): React.JSX.Element {
  const to = selection?.to ?? active ?? builds[0]?.buildId ?? '';
  const from =
    selection?.from ??
    builds.find((build) => build.buildId !== to)?.buildId ??
    builds[0]?.buildId ??
    '';

  const diff = useDiff(from, to, from !== '' && to !== '');

  return (
    <section className="compare">
      <h2 className="section-heading">Compare</h2>
      <div className="compare-controls">
        <label className="compare-field">
          <span>from</span>
          <select value={from} onChange={(event) => onSelect({ from: event.target.value, to })}>
            {builds.map((build) => (
              <option key={build.buildId} value={build.buildId}>
                {shorten(build.buildId)}
              </option>
            ))}
          </select>
        </label>
        <label className="compare-field">
          <span>to</span>
          <select value={to} onChange={(event) => onSelect({ from, to: event.target.value })}>
            {builds.map((build) => (
              <option key={build.buildId} value={build.buildId}>
                {shorten(build.buildId)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {diff.isPending && <Loading label="Comparing." />}
      {diff.isError && <Failure {...toDisplayable(diff.error)} />}
      {diff.data !== undefined && <DiffBody diff={diff.data} />}
    </section>
  );
}

function useDiff(
  from: string,
  to: string,
  enabled: boolean,
): ReturnType<typeof useQuery<Diff, unknown>> {
  return useQuery<Diff, unknown>({
    queryKey: ['diff', from, to],
    enabled,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/v1/builds/${encodeURIComponent(from)}/diff/${encodeURIComponent(to)}`,
        { signal },
      );
      const parsed = await response.json();
      if (!response.ok) throw parsed;
      return parsed as Diff;
    },
  });
}

/**
 * Section 18.3's sections, in section 18.3's order, so the CLI and Studio tell one story.
 *
 * The markers are the point. `+`, `~` and `-` carry added, changed and removed on their own;
 * colour only reinforces them. The whole thing still reads in greyscale, printed, or to
 * someone who cannot tell the two greens apart.
 */
function DiffBody({ diff }: { readonly diff: Diff }): React.JSX.Element {
  if (diff.identical) {
    return (
      <div className="diff">
        {diff.incompatibilities.length > 0 && <Incompatible diff={diff} />}
        <p className="diff-identical prose">
          No differences. These two builds compiled to the same content.
        </p>
      </div>
    );
  }

  return (
    <div className="diff">
      {diff.incompatibilities.length > 0 && <Incompatible diff={diff} />}
      <DiffSections diff={diff} />
    </div>
  );
}

/**
 * Stated rather than smoothed over. A comparison across a format change can mislead, and the
 * honest thing is to say so above the numbers rather than to quietly render them.
 */
function Incompatible({ diff }: { readonly diff: Diff }): React.JSX.Element {
  return (
    <div className="diff-incompatible">
      <h3 className="diff-heading">Incompatible builds</h3>
      <ul className="diff-list">
        {diff.incompatibilities.map((problem) => (
          <li key={problem.field} className="diff-changed">
            <span className="diff-marker">~</span>
            <span>{`${problem.field} ${problem.from} -> ${problem.to}`}</span>
          </li>
        ))}
      </ul>
      <p className="prose diff-note">Record-level comparison across this change may mislead.</p>
    </div>
  );
}

function DiffSections({ diff }: { readonly diff: Diff }): React.JSX.Element {
  return (
    <>
      <section className="diff-section">
        <h3 className="diff-heading">Artifacts</h3>
        {diff.artifacts.changes.length === 0 ? (
          <p className="diff-none">none</p>
        ) : (
          <ul className="diff-list">
            {diff.artifacts.changes.map((change) => (
              <li key={`${change.change}-${change.path}`} className={`diff-${change.change}`}>
                <span className="diff-marker">{MARKERS[change.change]}</span>
                <span className="diff-path">{change.path}</span>
                {change.sameContentAs !== undefined && (
                  // Reported, never concluded. Lorepack states that two paths hold the same
                  // bytes and lets the reader decide whether that was a move (invariant 6).
                  <span className="diff-note">{`same content as ${change.sameContentAs}`}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="diff-section">
        <h3 className="diff-heading">Rules</h3>
        {diff.rules.length === 0 ? (
          <p className="diff-none">none</p>
        ) : (
          <ul className="diff-list">
            {diff.rules.map((rule) => (
              <li key={`${rule.path}-${rule.field}`} className="diff-changed">
                <span className="diff-marker">~</span>
                <span className="diff-path">{rule.path}</span>
                <span className="diff-note">
                  {`${rule.field} ${rule.from ?? 'none'} -> ${rule.to ?? 'none'}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="diff-section">
        <h3 className="diff-heading">Context</h3>
        <ul className="diff-list">
          <li className="diff-added">
            <span className="diff-marker">+</span>
            <span>{plural(diff.chunks.added, 'chunk')}</span>
          </li>
          <li className="diff-changed">
            <span className="diff-marker">~</span>
            <span>{plural(diff.chunks.changed, 'chunk')}</span>
          </li>
          <li className="diff-removed">
            <span className="diff-marker">-</span>
            <span>{plural(diff.chunks.removed, 'chunk')}</span>
          </li>
        </ul>
      </section>

      <section className="diff-section">
        <h3 className="diff-heading">Tables</h3>
        {diff.tables.length === 0 ? (
          <p className="diff-none">none</p>
        ) : (
          <ul className="diff-list">
            {diff.tables.map((table) => (
              <li key={table.tableId} className="diff-changed">
                <span className="diff-marker">~</span>
                <span className="diff-path">{table.name}</span>
                <span className="diff-note">
                  {`rows ${table.rowsBefore ?? 'none'} -> ${table.rowsAfter ?? 'none'}`}
                  {table.columnsAdded.length > 0 && ` columns + ${table.columnsAdded.join(', ')}`}
                  {table.columnsRemoved.length > 0 &&
                    ` columns - ${table.columnsRemoved.join(', ')}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="diff-section">
        <h3 className="diff-heading">Capabilities</h3>
        <ul className="diff-list">
          {diff.capabilities.map((capability) => (
            <li key={capability.capability} className={`diff-${capability.change}`}>
              <span className="diff-marker">{MARKERS[capability.change]}</span>
              <span>{capability.capability}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const MARKERS: Record<string, string> = {
  added: '+',
  changed: '~',
  removed: '-',
  same: '=',
};

/**
 * The build a rollback would return to, chosen exactly the way the server chooses it.
 *
 * Duplicated deliberately, because the confirmation has to name a build before the request
 * is made. The two cannot drift silently: the confirmed id is sent back as `expect`, and the
 * server refuses to act if its own answer differs.
 */
/**
 * The two states a build can be activated or packed from.
 *
 * `active` is one of them: activation marks the live build `active` and returns the one it
 * replaced to `verified`, so a build that has been live before is still perfectly good.
 */
function isActivatable(state: string): boolean {
  return state === 'verified' || state === 'active';
}

/** State is a fact about a build, not a judgement, so only a failed one reads as bad. */
function toneForBuildState(state: string): 'ok' | 'warn' | 'bad' | 'idle' {
  if (isActivatable(state)) return 'ok';
  if (state === 'failed') return 'bad';
  return 'warn';
}

function previousBuild(builds: readonly Build[], active: string | null): string | null {
  const candidates = builds.filter(
    (build) => build.buildId !== active && (build.state === 'verified' || build.state === 'active'),
  );
  return candidates[0]?.buildId ?? null;
}

function endpointFor(action: Pending): string {
  if (action.kind === 'activate') return '/v1/builds/activate';
  if (action.kind === 'rollback') return '/v1/builds/rollback';
  return '/v1/builds/pack';
}

function bodyFor(action: Pending): Record<string, string> {
  if (action.kind === 'rollback') return { expect: action.build };
  return { build: action.build };
}

/** The result, in the tense of the button that produced it. */
function describeOutcome(action: Pending, result: Record<string, unknown>): string {
  const verb = VERBS[action.kind].past;

  if (action.kind === 'pack') {
    return `${verb} ${shorten(String(result.buildId))} into ${String(result.archive)}, ${plural(
      Number(result.members),
      'member',
    )} including the checksum index.`;
  }

  const buildId = shorten(String(result.buildId));
  if (result.changed === false) return `${buildId} was already active. Nothing changed.`;
  return `${verb} ${buildId}. Generation ${String(result.generation)}.`;
}

/** Enough of a build id to recognise. The whole of it is in the title attribute. */
function shorten(buildId: string): string {
  return buildId.length > 17 ? buildId.slice(0, 17) : buildId;
}

function plural(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;
}

/** Local time, because a build history is read on the machine that made it. */
function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
