import type { ContextBundle } from '@lorepack/core/worker';
import type { RankingReport } from '../ranking/rank.js';

export function selectTableReferences(
  buildId: ContextBundle['buildId'],
  report: RankingReport,
): { tables: ContextBundle['tables']; descriptionChunks: ReadonlySet<string> } {
  const visible = [
    ...report.kept,
    ...report.dropped
      .filter(({ reason }) => reason === 'duplicate' || reason === 'diversity')
      .map(({ ranked }) => ranked),
  ].sort(
    (a, b) =>
      b.score - a.score ||
      (a.hit.chunkId < b.hit.chunkId ? -1 : a.hit.chunkId > b.hit.chunkId ? 1 : 0),
  );
  const tables: ContextBundle['tables'] = [];
  const offered = new Set<string>();
  const descriptionChunks = new Set<string>();
  for (const ranked of visible) {
    for (const table of ranked.hit.tableReferences ?? []) {
      descriptionChunks.add(ranked.hit.chunkId);
      if (offered.has(table.tableId)) continue;
      offered.add(table.tableId);
      tables.push({
        tableId: table.tableId,
        name: table.name,
        descriptionChunkId: ranked.hit.chunkId,
        labels: ranked.labels,
        locator: table.locator,
        schemaReference: { buildId, tableId: table.tableId },
      });
    }
  }
  return { tables, descriptionChunks };
}
