import { join } from 'node:path';
import {
  type CatalogSearchOptions,
  countRows,
  LocalActiveBuildProvider,
  restrictToTables,
  SEARCH_TABLES,
  searchCatalog,
} from '@lorepack/backend-local';
import {
  LORE_DIRECTORY,
  type LoadedConfig,
  LoreError,
  type SearchResult,
  type SourceState,
} from '@lorepack/core';
import { openStateStore } from './builds.js';

/**
 * `lore search` over the active build.
 *
 * The result shape is the committed `search-result` contract, not a CLI-shaped invention.
 * Phase 2 replaces the query internals with `LoreRuntime.search`, and the point of using
 * the published schema now is that the swap changes nothing a caller can see.
 */

export interface SearchOptions {
  readonly config: LoadedConfig;
  readonly query: string;
  readonly sourceState: SourceState;
  readonly limit?: number;
  readonly pathGlob?: string;
  readonly type?: string;
}

export async function runSearch(options: SearchOptions): Promise<SearchResult> {
  const loreDirectory = join(options.config.projectRoot, LORE_DIRECTORY);
  const state = openStateStore(loreDirectory);
  const provider = new LocalActiveBuildProvider(state, join(loreDirectory, 'builds'));

  try {
    if (state.current() === null) {
      throw new LoreError('LORE_E_BUILD_NOT_FOUND', 'This project has no active build to search.', {
        remediation: 'Run `lore build` first.',
      });
    }

    // A handle, not a path lookup: the generation is read at acquisition and held for the
    // whole query, so an activation mid-search cannot mix two builds into one answer
    // (architecture section 15.2).
    const handle = await provider.acquire();
    const db = provider.database(handle);
    try {
      // Defence in depth: the authorizer refuses everything outside the search tables, so
      // a future bug in query construction cannot read something it should not. This is
      // the first code that turns user input into SQL, which is the right place to start.
      restrictToTables(db, SEARCH_TABLES);

      const criteria: CatalogSearchOptions = {
        limit: options.limit ?? 10,
        ...(options.pathGlob === undefined ? {} : { pathGlob: options.pathGlob }),
        ...(options.type === undefined ? {} : { extension: options.type }),
      };
      const hits = searchCatalog(db, options.query, criteria);

      return {
        buildId: handle.buildId,
        sourceState: options.sourceState,
        totalIndexedChunks: countRows(db, 'chunks'),
        hits: hits.map((hit) => ({
          chunkId: hit.chunkId,
          artifactId: hit.artifactId,
          // BM25 is negative and lower is better. Reported as produced and labelled a raw
          // lexical score: the comparable number arrives with the Phase 2 ranking
          // pipeline, and inventing one now would be a figure nobody could act on.
          score: hit.bm25,
          excerpt: hit.excerpt,
          headingPath: [...hit.headingPath],
          status: hit.status as SearchResult['hits'][number]['status'],
          labels: labelsFor(hit.status),
          // Provenance is mandatory (section 10.8). The locator is built from the same row
          // as the hit, so a result can never exist without one.
          locator: {
            artifactId: hit.artifactId,
            relativePath: hit.relativePath,
            ...(hit.headingPath.length === 0 ? {} : { headingPath: [...hit.headingPath] }),
            ...(hit.lineStart === null || hit.lineStart <= 0 ? {} : { lineStart: hit.lineStart }),
            ...(hit.lineEnd === null || hit.lineEnd <= 0 ? {} : { lineEnd: hit.lineEnd }),
          },
        })),
      };
    } finally {
      handle.release();
    }
  } finally {
    provider.closeAll();
    state.close();
  }
}

function labelsFor(status: string): SearchResult['hits'][number]['labels'] {
  return status === 'draft' || status === 'archived' || status === 'superseded' ? [status] : [];
}

export function renderSearch(result: SearchResult, query: string): string {
  const lines = [
    `Build ${result.buildId.slice(0, 17)} (sources ${result.sourceState}), ${result.totalIndexedChunks} chunks indexed`,
    '',
  ];

  if (result.hits.length === 0) {
    lines.push(`No matches for "${query}".`);
    lines.push('');
    lines.push(
      result.totalIndexedChunks === 0
        ? 'This build indexed nothing. Run `lore inspect warnings` to see what was skipped.'
        : `Searched ${result.totalIndexedChunks} chunks. Try fewer or more general terms.`,
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
    lines.push(`${String(rank).padStart(2)}. ${where}  (score ${hit.score.toFixed(2)})`);
    if (hit.headingPath.length > 0) lines.push(`    ${hit.headingPath.join(' > ')}`);
    if (hit.labels.length > 0) lines.push(`    [${hit.labels.join(', ')}]`);
    lines.push(`    ${hit.excerpt.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
