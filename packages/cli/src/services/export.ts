import { type ContextBundle, count } from '@lorepack/core';

/**
 * Rendering a bundle as Markdown: architecture 14.6.
 *
 * This is the compatibility bridge for every chat product that cannot speak MCP, which is
 * most of them. A person pastes one file and the model has the corpus, the citations, and
 * an honest account of what did not fit.
 *
 * Nothing here writes prose about the content. Every passage is text from a document, and
 * the only sentences Lorepack contributes are structural: what this is, where it came
 * from, and what was left out.
 */

export interface ExportOptions {
  readonly projectName: string;
  /** How to ask for more, rendered verbatim so a reader can copy it. */
  readonly moreCommand: string;
  readonly sourceState: ContextBundle['sourceState'];
}

/**
 * The command that asks for more of the same, for a reader to copy into a shell.
 *
 * The task is single-quoted, which a POSIX shell takes literally. `JSON.stringify` produced
 * double quotes, inside which `$(...)` and backticks still run (#552).
 */
export function moreCommandFor(task: string): string {
  return `lorepack export --task '${task.replaceAll("'", "'\\''")}' --profile deep`;
}

export function renderBundleMarkdown(bundle: ContextBundle, options: ExportOptions): string {
  const lines: string[] = [];

  lines.push(`# Context for: ${oneLine(bundle.task)}`, '');
  lines.push(`Project **${options.projectName}**, build \`${bundle.buildId}\`.`);
  lines.push(
    `Profile **${bundle.profile}**, budget ${count(bundle.budget, 'estimated token')}, of which ${count(bundle.estimatedTokens, 'estimated token')} used.`,
  );
  if (options.sourceState === 'dirty') {
    lines.push('');
    lines.push(
      '> The sources have changed since this build was compiled, so this context is behind them. Run `lorepack build` and export again for current context.',
    );
  } else if (options.sourceState === 'unknown') {
    lines.push('');
    lines.push('> Freshness could not be established, so this context may be behind the sources.');
  }
  lines.push('');
  lines.push(
    'Every passage below is quoted from a document in this project, with the file and source coordinate it came from. Lorepack selected and bounded them; it did not write or summarise anything, and it makes no claim about which document is correct.',
  );
  lines.push(
    `Search considered up to ${count(bundle.candidateLimit, 'candidate')} using ${bundle.candidateMatchMode}-term matching${bundle.candidateLimitHit ? ', and the candidate limit was reached' : ''}.`,
  );
  lines.push('');

  const included = [...bundle.overview, ...bundle.selected];
  if (included.length > 0) {
    lines.push('## Context', '');
    // Grouped by source, which is how a reader navigates it: one heading per document,
    // passages in the order the assembler chose them.
    for (const [path, items] of groupBySource(included)) {
      lines.push(`### ${oneLine(path)}`, '');
      for (const item of items) {
        const heading =
          item.headingPath.length === 0 ? '' : `${oneLine(item.headingPath.join(' > '))}, `;
        const labels = item.labels.length === 0 ? '' : ` [${item.labels.join(', ')}]`;
        lines.push(`**${heading}${lineRange(item.locator)}**${labels}`, '');
        // Fenced, because the text is a document's and the lines around it are Lorepack's.
        // Appended raw, a plain-text source could write `## Citations` and a `### path` of
        // its choosing and pass its claim off as another file's (#552).
        lines.push(...fenced(item.text.trim(), 'text'), '');
      }
    }
  }

  if (bundle.alternatives.length > 0) {
    lines.push('## Alternative relevant sources', '');
    lines.push(
      'These matched the task and were held back by their declared status. They are listed, not judged.',
      '',
    );
    for (const item of bundle.alternatives) {
      const labels = item.labels.length === 0 ? '' : ` [${item.labels.join(', ')}]`;
      lines.push(`- \`${item.locator.relativePath}\` ${lineRange(item.locator)}${labels}`);
    }
    lines.push('');
  }

  if (bundle.tables.length > 0) {
    lines.push('## Tables', '');
    for (const table of bundle.tables) lines.push(`- ${table.name} (\`${table.tableId}\`)`);
    lines.push('');
  }

  lines.push('## Citations', '');
  for (const citation of bundle.citations) {
    lines.push(`- \`${citation.relativePath}\` ${lineRange(citation)}`);
  }
  lines.push('');

  lines.push('## What was left out', '');
  if (bundle.omitted.length === 0) {
    lines.push('Nothing from the candidates considered was omitted.', '');
  } else {
    lines.push(
      `${count(bundle.omitted.length, 'passage')} considered candidates did not fit, grouped by reason. The report covers the candidates considered above.`,
      '',
    );
    for (const [reason, items] of groupByReason(bundle.omitted)) {
      lines.push(`**${describeReason(reason)}** (${count(items.length, 'passage')})`, '');
      for (const item of items.slice(0, 20)) {
        lines.push(
          `- \`${item.locator.relativePath}\` ${lineRange(item.locator)}, about ${count(item.estimatedTokens, 'token')}`,
        );
      }
      if (items.length > 20) lines.push(`- and ${count(items.length - 20, 'more passage')}`);
      lines.push('');
    }
  }

  lines.push('## Getting more', '');
  lines.push('To widen this context, raise the budget or name a profile with a larger one:', '');
  lines.push(...fenced(options.moreCommand, 'bash'), '');
  lines.push(
    `Token counts are conservative estimates from a deterministic counter, not a model tokenizer. Treat them as a bound, not a measurement.`,
  );

  return `${lines.join('\n').trimEnd()}\n`;
}

function groupBySource(
  items: readonly ContextBundle['selected'][number][],
): Array<[string, ContextBundle['selected'][number][]]> {
  const groups = new Map<string, ContextBundle['selected'][number][]>();
  for (const item of items) {
    const path = item.locator.relativePath;
    const bucket = groups.get(path);
    if (bucket === undefined) groups.set(path, [item]);
    else bucket.push(item);
  }
  return [...groups.entries()];
}

function groupByReason(
  items: readonly ContextBundle['omitted'][number][],
): Array<[string, ContextBundle['omitted'][number][]]> {
  const groups = new Map<string, ContextBundle['omitted'][number][]>();
  for (const item of items) {
    const bucket = groups.get(item.reason);
    if (bucket === undefined) groups.set(item.reason, [item]);
    else bucket.push(item);
  }
  // Sorted so the same bundle always renders the same file, which is what lets a person
  // diff two exports and see what changed rather than what moved.
  return [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
}

function describeReason(reason: string): string {
  switch (reason) {
    case 'budget':
      return 'Did not fit in the budget';
    case 'duplicate':
      return 'Near-duplicate of a passage above';
    case 'diversity':
      return 'One document may not fill the whole bundle';
    case 'superseded':
      return 'Superseded by another document';
    case 'archived':
      return 'Archived';
    default:
      return 'Filtered out';
  }
}

function lineRange(locator: ContextBundle['citations'][number]): string {
  if (locator.page !== undefined) return `page ${locator.page}`;
  if (locator.sheet !== undefined || locator.cellRange !== undefined) {
    return [locator.sheet, locator.cellRange].filter(Boolean).join(' ');
  }
  if (locator.lineStart === undefined) return '';
  return locator.lineEnd === undefined || locator.lineEnd === locator.lineStart
    ? `line ${locator.lineStart}`
    : `lines ${locator.lineStart}-${locator.lineEnd}`;
}

/**
 * A fenced block that the text inside cannot close.
 *
 * CommonMark closes a fence only on a run of at least as many backticks as opened it, so the
 * fence is one longer than the longest run in the text. Inside it nothing renders as a
 * heading, a list or emphasis: the passage is shown exactly as the document has it.
 */
function fenced(text: string, info: string): string[] {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return [`${marker}${info}`, text, marker];
}

/** A label that must stay on its line: a path or a heading cannot start a new one. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}
