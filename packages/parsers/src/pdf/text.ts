/**
 * Turning a PDF's text layer into paragraphs, under a documented policy.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and pdfjs hands them back as runs
 * with occasional end-of-line markers. Everything below is a decision about how to read that,
 * which means every rule here changes what a build contains and is covered by the parser
 * version.
 *
 * The rules are deliberately conservative. Where a transformation could be wrong, the text is
 * left alone: a document with an odd hyphen is a small annoyance, and a document whose words
 * were silently joined wrongly is a corpus nobody can trust.
 */

export const PDF_LIMITS = {
  /** Section 5.4. Beyond this a warning, because extraction is linear in pages. */
  warnPages: 500,
  /**
   * A hard stop. Not in the spec as a number, but a build that hangs for ten minutes on one
   * file is worse than a build that refuses it and says why.
   */
  maxPages: 5000,
  /** Bumping this is a parser-version change: it alters the text a build stores. */
  normalizationVersion: 1,
} as const;

/**
 * Ligatures, which PDF fonts encode as single glyphs.
 *
 * Left as-is they make a word unsearchable: "workflow" typeset with an fl ligature does not
 * match a query for "workflow", and the reader cannot see why. This is the one substitution
 * that is unambiguous, because these codepoints have exactly one expansion.
 */
const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  [/ﬅ/g, 'st'],
  [/ﬆ/g, 'st'],
];

/**
 * A hyphen at a line break, and why the hyphen stays.
 *
 * `depart-\nment` is one word split by typesetting; `long-\nterm` is a real compound that
 * happened to wrap at its hyphen. **Nothing in the text layer distinguishes them**, and the
 * two repairs disagree: removing the hyphen turns "long-term" into "longterm", and keeping it
 * turns "department" into "depart-ment".
 *
 * So the line is joined without inserting a space, and the hyphen is left exactly where the
 * document put it. That choice is not neutral, it is the conservative one: keeping the hyphen
 * preserves what was on the page and a reader can see it, while removing it fabricates a
 * spelling that appears in no document anywhere. Section 12.6's rule for tables is the same
 * instinct, and #72 asks for a documented policy rather than a clever one.
 */
function joinHyphenatedBreaks(text: string): string {
  return text.replace(/(\p{L})([-‐])\n(\p{L})/gu, '$1$2$3');
}

/**
 * Paragraph text for one page, in reading order as the text layer gives it.
 *
 * A blank line separates paragraphs; a single line break inside one is joined with a space,
 * because a PDF breaks lines for the page width rather than for meaning.
 */
export function normalizePageText(raw: string): string[] {
  let text = raw.replace(/\r\n?/g, '\n');
  for (const [pattern, replacement] of LIGATURES) text = text.replace(pattern, replacement);
  text = joinHyphenatedBreaks(text);

  return text
    .split(/\n[ \t]*\n+/)
    .map((block) =>
      block
        // A line break inside a paragraph is a typesetting artefact, not a sentence boundary.
        .replace(/\n/g, ' ')
        // Runs of spaces are how a PDF fakes justification and indentation.
        .replace(/[ \t ]+/g, ' ')
        .trim(),
    )
    .filter((block) => block !== '');
}
