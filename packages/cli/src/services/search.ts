import { createLocalRuntimeBackend } from '@lorepack/backend-local';
import {
  count,
  type LoadedConfig,
  LoreError,
  type SearchResult,
  type SourceState,
} from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';

/**
 * `lore search` over the active build.
 *
 * The query itself lives in `LoreRuntime.search`, which MCP, REST and Studio also call.
 * This file is the CLI's adapter to it: build the local ports, ask, render. Keeping a
 * second search path here would mean two ranking implementations and two response shapes
 * to hold in step, and the shape is a published contract.
 */

export interface SearchOptions {
  readonly config: LoadedConfig;
  readonly query: string;
  readonly sourceState: SourceState;
  readonly limit?: number;
  readonly pathGlob?: string;
  readonly type?: string;
  readonly includeArchived?: boolean;
  /** Returns the score components, so a reader can see why a page is ordered as it is. */
  readonly debug?: boolean;
}

export async function runSearch(options: SearchOptions): Promise<SearchResult> {
  const backend = createLocalRuntimeBackend({
    projectRoot: options.config.projectRoot,
    // The CLI has already established freshness for its own header, so the runtime is
    // handed the answer rather than made to work it out again.
    freshness: async () => options.sourceState,
  });

  try {
    if ((await backend.provider.current()) === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build to search.', {
        remediation: 'Run `lore build` first.',
      });
    }

    return await createRuntime(backend).search({
      query: options.query,
      limit: options.limit ?? 10,
      includeArchived: options.includeArchived ?? false,
      debug: options.debug ?? false,
      ...(options.pathGlob === undefined ? {} : { pathGlob: options.pathGlob }),
      ...(options.type === undefined ? {} : { fileType: options.type }),
    });
  } finally {
    backend.close();
  }
}

export function renderSearch(result: SearchResult, query: string, verbose = false): string {
  const lines = [
    `Build ${result.buildId.slice(0, 17)} (sources ${result.sourceState}), ${count(result.totalIndexedChunks, 'chunk')} indexed`,
    '',
  ];

  if (result.hits.length === 0) {
    lines.push(`No matches for "${query}".`);
    lines.push('');
    lines.push(
      result.totalIndexedChunks === 0
        ? 'This build indexed nothing. Run `lore inspect warnings` to see what was skipped.'
        : `Searched ${count(result.totalIndexedChunks, 'chunk')}. Try fewer or more general terms.`,
    );
    return lines.join('\n');
  }

  let rank = 0;
  for (const hit of result.hits) {
    rank += 1;
    const where =
      hit.locator.lineStart === undefined
        ? hit.locator.relativePath
        : `${hit.locator.relativePath}:${hit.locator.lineStart}`;
    // The rank is the claim, and the score is shown only when asked for. It is a
    // relevance heuristic: how well the words match, not how likely the content is to be
    // right. Printing it beside every result would invite reading it as confidence.
    lines.push(
      `${String(rank).padStart(2)}. ${where}${verbose ? `  (relevance ${hit.score.toFixed(2)})` : ''}`,
    );
    if (hit.headingPath.length > 0) lines.push(`    ${hit.headingPath.join(' > ')}`);
    if (hit.labels.length > 0) lines.push(`    [${hit.labels.join(', ')}]`);
    lines.push(`    ${hit.excerpt.replace(/\s+/g, ' ').trim()}`);
    if (hit.scoreComponents !== undefined) {
      lines.push(`    why: ${renderComponents(hit.scoreComponents)}`);
    }
    lines.push('');
  }

  if (result.hits.some((hit) => hit.scoreComponents !== undefined)) {
    lines.push('Relevance is a heuristic about matching words. It is not a confidence, and');
    lines.push('it is not evidence that a document is correct.');
  }

  return lines.join('\n').trimEnd();
}

/** The components in the order they are applied, so the line reads like the calculation. */
function renderComponents(components: Readonly<Record<string, number>>): string {
  const order = [
    'lexical',
    'pathExact',
    'titleExact',
    'headingExact',
    'allTerms',
    'statusFactor',
    'authorityFactor',
    'supersededFactor',
    'total',
  ];
  return order
    .filter((name) => components[name] !== undefined)
    .map((name) => `${name} ${(components[name] as number).toFixed(2)}`)
    .join(', ');
}
