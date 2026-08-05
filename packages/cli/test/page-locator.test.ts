import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import { loadConfig, ProgressBus } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { makePdf, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';

/**
 * A citation names the coordinate its format actually has (#241).
 *
 * A PDF has pages and no lines; a Markdown file has lines and no pages. Before this, a PDF hit
 * arrived with `lineStart: 1` and no page at all: the parser recorded the page, `chunks` had no
 * column for it, and search hits are built from chunks. A line number of 1 on a binary PDF is
 * worse than no coordinate, because it looks checkable.
 *
 * These assert **both directions**. A fix that put a page on everything, or that dropped line
 * numbers from Markdown to make PDFs pass, would trade one format for another.
 */

const CONFIG = 'version: 1\nname: cited\nsources:\n  - .\n';

const MARKDOWN = ['# Notes', '', '## Detail', '', 'A markdown file keeps its line range.', ''].join(
  '\n',
);

async function withCitedProject<T>(
  body: (runtime: ReturnType<typeof createRuntime>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, 'notes.md': MARKDOWN } }, async (temp) => {
    writeFileSync(
      join(temp.root, 'contract.pdf'),
      makePdf(
        [
          { lines: ['Support contract', 'Response times are measured in business hours.'] },
          { lines: ['Escalation', 'A critical incident escalates after thirty minutes.'] },
        ],
        { title: 'Support contract' },
      ),
    );
    await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });

    const backend = createLocalRuntimeBackend({ projectRoot: temp.root });
    try {
      return await body(createRuntime(backend));
    } finally {
      backend.close();
    }
  });
}

const search = (runtime: ReturnType<typeof createRuntime>, query: string) =>
  runtime.search({ query, limit: 5, includeArchived: false, debug: false });

describe('a hit is cited by the coordinate its format has', () => {
  it('gives a PDF a page, and no line number it does not have', async () => {
    await withCitedProject(async (runtime) => {
      const result = await search(runtime, 'escalation');
      const hit = result.hits[0];

      expect(hit?.locator.relativePath).toMatch(/contract\.pdf/);
      // The phrase is only on the second page, so the page is checkable rather than incidental.
      expect(hit?.locator.page).toBe(2);
      expect(hit?.locator.lineStart).toBeUndefined();
      expect(hit?.locator.lineEnd).toBeUndefined();
    });
  });

  it('gives Markdown its real line range, and no page', async () => {
    await withCitedProject(async (runtime) => {
      const result = await search(runtime, 'line range');
      const hit = result.hits[0];

      expect(hit?.locator.relativePath).toMatch(/notes\.md/);
      expect(hit?.locator.page).toBeUndefined();
      // The sentence is on line 5, and the fix must not have cost this.
      expect(hit?.locator.lineStart).toBe(5);
    });
  });

  /**
   * The equality worth asserting: two representations of one fact must agree.
   *
   * The heading is what a person reads and the page is what a client acts on. They are written
   * by different code paths, so a fix to one that missed the other would be invisible to a
   * check that only looked at whichever it chose.
   */
  it('agrees with the heading the same hit carries', async () => {
    await withCitedProject(async (runtime) => {
      const result = await search(runtime, 'escalation');
      const hit = result.hits[0];

      expect(hit?.locator.headingPath?.[0]).toBe(`Page ${String(hit?.locator.page)}`);
    });
  });

  /**
   * A citation is a citation wherever it appears, so `search` must not be a special case.
   *
   * Stated as an invariant over **every** item rather than as "the bundle selects the PDF".
   * Which passages a bundle selects is a ranking outcome, and a test that depends on one is
   * testing the ranker; this holds whatever the ranker chooses, including when it chooses
   * nothing. The mixed-corpus acceptance scenario covers the populated case end to end.
   */
  it('never puts a line number on a PDF anywhere in a bundle', async () => {
    await withCitedProject(async (runtime) => {
      const bundle = await runtime.contextForTask({
        task: 'escalation critical incident response times',
        includeArchived: false,
        allowUnsupportedBudget: false,
      });

      const everything = [...bundle.overview, ...bundle.selected];
      expect(everything.length).toBeGreaterThan(0);

      for (const item of everything) {
        if (!/\.pdf$/.test(item.locator.relativePath)) continue;
        expect(item.locator.lineStart).toBeUndefined();
        expect(item.locator.lineEnd).toBeUndefined();
      }

      // And the citations, which are assembled from the same locators and are what a reader
      // actually pastes into a conversation.
      for (const locator of bundle.citations) {
        if (!/\.pdf$/.test(locator.relativePath)) continue;
        expect(locator.lineStart).toBeUndefined();
      }
    });
  });
});
