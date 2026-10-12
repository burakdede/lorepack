import {
  CANONICALIZATION_VERSION,
  hashCanonicalPortable,
  type RuntimeIdentity,
  TABLE_QUERY_LIMITS,
  type TableQueryRequest,
} from '@lorepack/core/worker';

export async function identifyTableQuery(
  request: TableQueryRequest,
  envelope: RuntimeIdentity & { readonly buildId: string },
): Promise<string> {
  return `query_${await hashCanonicalPortable({
    domain: 'lorepack-table-query-v1',
    canonicalizationVersion: CANONICALIZATION_VERSION,
    corpusId: envelope.corpusId,
    namespaceId: envelope.namespaceId,
    buildId: envelope.buildId,
    tableId: request.tableId,
    sql: request.sql,
    rowLimit: request.limit ?? TABLE_QUERY_LIMITS.defaultRows,
    maximumRows: TABLE_QUERY_LIMITS.maxRows,
    maximumBytes: TABLE_QUERY_LIMITS.maxBytes,
    provenancePrecision: 'table',
  })}`;
}
