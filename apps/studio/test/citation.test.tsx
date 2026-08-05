import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Citation, formatCitation, type Locator } from '../src/components/Citation.js';

/**
 * The citation, which is how provenance reaches a reader.
 *
 * These assert **the whole string**, not that each part appears somewhere. Every part being
 * present was true the entire time a screen reader was hearing `orders.xlsxOrdersA1:D4`
 * (#238): the parts were separated by an `aria-hidden` dot and a CSS gap, neither of which is
 * text. That is #203 in a component written before it, and a presence check cannot see it.
 *
 * The second assertion in each case is the equality that keeps it fixed: what is rendered and
 * what `formatCitation` produces are the same string, so the copy button and the screen can
 * never drift apart.
 */

/** The rendered text a reader gets, without the copy button's own label. */
function rendered(): string {
  const citation = document.querySelector('.citation');
  const copy = citation?.querySelector('.citation-copy');
  copy?.remove();
  return citation?.textContent ?? '';
}

describe('a citation reads as separate words', () => {
  it('separates every part of a spreadsheet locator', () => {
    const locator: Locator = {
      artifactId: 'p:orders.xlsx',
      relativePath: 'orders.xlsx',
      sheet: 'Orders',
      cellRange: 'A1:D4',
    };
    render(<Citation locator={locator} />);

    expect(rendered()).toBe('orders.xlsx · Orders · A1:D4');
    expect(rendered()).toBe(formatCitation(locator));
  });

  it('separates a heading path from the file and the lines', () => {
    const locator: Locator = {
      relativePath: 'docs/runbook.md',
      headingPath: ['Rollback', 'Procedure'],
      lineStart: 12,
      lineEnd: 20,
    };
    render(<Citation locator={locator} />);

    expect(rendered()).toBe('docs/runbook.md · Rollback › Procedure · 12-20');
    expect(rendered()).toBe(formatCitation(locator));
  });

  it('writes no separator when there is only a path', () => {
    const locator: Locator = { relativePath: 'notes.md' };
    render(<Citation locator={locator} />);

    // A trailing or leading separator would be a word boundary around nothing.
    expect(rendered()).toBe('notes.md');
    expect(rendered()).toBe(formatCitation(locator));
  });

  it('offers the same string to the clipboard that it shows', () => {
    const locator: Locator = { relativePath: 'orders.xlsx', sheet: 'Q3', cellRange: 'B2:F40' };
    render(<Citation locator={locator} />);

    // The button's label names what it copies, so the affordance is not a mystery.
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(formatCitation(locator)).toBe('orders.xlsx · Q3 · B2:F40');
  });
});
