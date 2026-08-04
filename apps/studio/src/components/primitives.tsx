import './primitives.css';

/**
 * The small set of shapes every route reuses.
 *
 * Deliberately not a component library. Architecture 8.8 asks for "a small accessible
 * component set", and the design document's rules (three state scales, no accent colour, no
 * cards, aligned key-value blocks echoing the CLI) are easier to hold in a handful of
 * purpose-built pieces than to enforce on top of a general one.
 */

/** The three state scales from the design document. There are no other colours. */
export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const FRESHNESS_TONE: Record<string, Tone> = {
  clean: 'ok',
  dirty: 'warn',
  unknown: 'idle',
};

const STATUS_TONE: Record<string, Tone> = {
  active: 'idle',
  draft: 'warn',
  archived: 'idle',
  superseded: 'idle',
};

const CHECK_TONE: Record<string, Tone> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'bad',
};

export function toneForFreshness(state: string): Tone {
  return FRESHNESS_TONE[state] ?? 'idle';
}

export function toneForStatus(status: string): Tone {
  return STATUS_TONE[status] ?? 'idle';
}

export function toneForCheck(status: string): Tone {
  return CHECK_TONE[status] ?? 'idle';
}

/**
 * Colour is never the only carrier of state, so a badge always shows the word. That is a
 * WCAG requirement and the reason the interface still reads in greyscale.
 */
export function Badge({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * The aligned key-value block, which is what the CLI already prints.
 *
 * This exists instead of stat tiles. These are facts about one immutable build, not metrics
 * trending over time, so there is no delta to show and nothing to plot.
 */
export function Facts({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <dl className="facts">{children}</dl>;
}

export function Fact({
  label,
  children,
  mono = true,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  /** Prose values opt out of monospace; identifiers and counts stay in it. */
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="fact">
      <dt className="fact-label">{label}</dt>
      <dd className={mono ? 'fact-value' : 'fact-value prose'}>{children}</dd>
    </div>
  );
}

/** Copy that is meant to be run, so it is selectable and copyable rather than illustrative. */
export function Command({ value }: { readonly value: string }): React.JSX.Element {
  return (
    <span className="command">
      <code>{value}</code>
      <button
        type="button"
        className="command-copy"
        onClick={() => void navigator.clipboard?.writeText(value)}
        aria-label={`Copy command ${value}`}
      >
        copy
      </button>
    </span>
  );
}

/**
 * Two values side by side, separated by real text rather than by a margin.
 *
 * The gap between adjacent inline elements is usually made with `margin-right`, which puts
 * a space on the screen and nothing in the document. A screen reader announced
 * "context/notes/logo.binHas no supported parser", and selecting the row copied the same
 * string (#203). Neither is visible to axe: the markup is valid, the contrast is fine, and
 * both words are present.
 *
 * Only a text node makes a word boundary, so this exists to put one there once rather than
 * to have three routes remember to type a space.
 */
export function Adjacent({
  lead,
  leadClassName,
  className,
  children,
}: {
  readonly lead: React.ReactNode;
  readonly leadClassName?: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <span className={leadClassName}>{lead}</span>
      {SEPARATOR}
      <span className={className}>{children}</span>
    </>
  );
}

/**
 * A named constant rather than a literal space between the tags.
 *
 * JSX keeps a space written between two elements on one line and drops it when they are on
 * separate lines, so the correctness of this component would otherwise depend on how the
 * formatter chose to wrap it. An expression container is not whitespace, so no reflow can
 * remove it.
 */
const SEPARATOR = ' ';

/**
 * An empty screen is an invitation to act, so it names the next command rather than
 * apologising.
 */
export function Empty({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty">
      <p className="empty-title prose">{title}</p>
      {children !== undefined && <div className="empty-body prose">{children}</div>}
    </div>
  );
}

/**
 * A failure explains what happened and how to fix it, in the interface's voice.
 *
 * The remediation comes from the Phase 0 error taxonomy, so Studio says exactly what the CLI
 * would say rather than inventing its own wording.
 */
export function Failure({
  message,
  code,
  remediation,
}: {
  readonly message: string;
  readonly code?: string;
  readonly remediation?: string;
}): React.JSX.Element {
  return (
    <div className="failure" role="alert">
      <p className="failure-message prose">{message}</p>
      {code !== undefined && <p className="failure-code">{code}</p>}
      {remediation !== undefined && <p className="failure-remediation prose">{remediation}</p>}
    </div>
  );
}

/**
 * A quiet placeholder, not a shimmer.
 *
 * Skeleton shimmer is on the anti-brief: it animates to imply progress it does not know
 * about, and on a local server most of these resolve before a person could read them anyway.
 */
export function Loading({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}
