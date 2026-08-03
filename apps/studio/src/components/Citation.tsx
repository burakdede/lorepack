import { useCallback, useState } from 'react';
import './Citation.css';

/**
 * The signature element, and the one place the design budget is spent.
 *
 * Invariant 5 says every search result, context item and table row carries a `SourceLocator`,
 * and that a result without one is a bug rather than a style issue. That line is the
 * product's whole thesis made visible, so it is one component used identically in the
 * Playground's selections and omissions, the Sources detail view, the Search tab and the diff
 * rows, rather than five formatters that drift.
 *
 *     docs/runbook.md · Release runbook › Rolling back · 9-11
 */

export interface Locator {
  readonly relativePath?: string;
  readonly artifactId?: string;
  readonly headingPath?: readonly string[];
  readonly lineStart?: number;
  readonly lineEnd?: number;
  /** Phase 5 adds these; rendered when present so the component does not need changing. */
  readonly page?: number;
  readonly sheet?: string;
  readonly cellRange?: string;
}

export function formatCitation(locator: Locator): string {
  const parts: string[] = [];
  const path = locator.relativePath ?? locator.artifactId;
  if (path !== undefined) parts.push(path);
  if (locator.sheet !== undefined) parts.push(locator.sheet);
  if (locator.headingPath !== undefined && locator.headingPath.length > 0) {
    parts.push(locator.headingPath.join(' › '));
  }
  const range = formatRange(locator);
  if (range !== null) parts.push(range);
  return parts.join(' · ');
}

function formatRange(locator: Locator): string | null {
  if (locator.cellRange !== undefined) return locator.cellRange;
  if (locator.page !== undefined) return `p${locator.page}`;
  if (locator.lineStart === undefined) return null;
  // A single line reads as one number, not as a range of one.
  return locator.lineEnd === undefined || locator.lineEnd === locator.lineStart
    ? String(locator.lineStart)
    : `${locator.lineStart}-${locator.lineEnd}`;
}

export function Citation({ locator }: { readonly locator: Locator }): React.JSX.Element {
  const text = formatCitation(locator);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);

  const path = locator.relativePath ?? locator.artifactId;
  const headings = locator.headingPath ?? [];
  const range = formatRange(locator);

  return (
    <span className="citation">
      {path !== undefined && <span className="citation-path">{path}</span>}
      {locator.sheet !== undefined && (
        <>
          <Separator />
          <span className="citation-path">{locator.sheet}</span>
        </>
      )}
      {headings.length > 0 && (
        <>
          <Separator />
          <span className="citation-headings">
            {headings.map((heading, index) => (
              // The prefix up to this segment, which is unique within a path by
              // construction, so the key survives a heading being renamed above it.
              <span key={headings.slice(0, index + 1).join('\u001f')}>
                {index > 0 && <span className="citation-chevron">{'›'}</span>}
                {heading}
              </span>
            ))}
          </span>
        </>
      )}
      {range !== null && (
        <>
          <Separator />
          <span className="citation-range">{range}</span>
        </>
      )}
      <button
        type="button"
        className="citation-copy"
        onClick={copy}
        // The full citation, because a screen reader user gets no benefit from the visual
        // assembly above and needs the thing the button will actually copy.
        aria-label={`Copy citation ${text}`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

function Separator(): React.JSX.Element {
  // Decorative: the structure is already conveyed by the elements it sits between.
  return (
    <span className="citation-separator" aria-hidden="true">
      {'·'}
    </span>
  );
}
