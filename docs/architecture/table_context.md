# Tables in task context

Task context returns table references alongside whole document evidence. For example:

```bash
lorepack export --task 'rate matrix' --format json
```

A matching entry in `tables` carries `tableId`, `name`, `labels`, `locator`,
`descriptionChunkId` and `schemaReference: {buildId, tableId}`. Pass that reference to
`lore_describe_table` over MCP. In the SDK, construct a `LoreClient` with the reference's
`buildId`, then call `describeTable(tableId)` on that selected client. The schema provides
generated SQL names; use the existing bounded table-query method to read rows. Always retain
the reference's build ID, even if the active build later changes.

HTTP `POST /v1/context`, MCP `lore_context_for_task`, SDK `contextForTask`, Studio Playground
and CLI JSON/Markdown export share this selection. Indexed table descriptions contain names,
column names and structural descriptions. Matching uses the existing lexical candidate
pipeline, including its candidate bounds, path/type/status filters and current-only
visibility. Explicit `includeArchived` also exposes historical references with their declared
labels. A matching workbook sheet identifies its own table, rather than every sheet.

Context replaces matched table-description passages with references. It does not turn
sample rows into prose. A schema read may return bounded typed sample rows, and an explicit
query returns typed rows with provenance. Ordinary search and source reads retain their
existing behavior. Native document evidence and its attached qualifications remain whole.

The existing complete-output budget measures references in JSON, complete MCP replies and
Markdown. A reference is included whole or removed whole. Removal contributes one `budget`
omission, identified by its source description chunk and `tableId`; totals still account
for entries when diagnostic detail cannot fit. Citations name only retained references and
retained document evidence. Packing policy version 4 and serialization policy versions 4 (ordinary) and 5 (receipt) identify
this contract; older recorded executions retain their original versions.

Local SQLite and namespaced D1 attach table IDs, names and stored locators to the existing
native-candidate query, resolving table IDs recorded on its native nodes. D1 correlations
retain project and build scope. Discovery adds no round trip and never issues a schema/sample
query per table. The public list-tables response remains the same ID/name listing. Studio displays each reference's source coordinate, declared labels
and full schema build ID. Its source coordinate is displayed without an active-build link.

See [verification](../testing/table_context.md) and [ADR 0035](../adr/0035-table-context-references.md).

The fitter skips further estimate convergence once the current representation already exceeds
its byte or token limit. It still evicts whole items in the original order, then measures
and converges the retained output. This avoids repeating large serializations for an output
that cannot be returned, without changing payload limits or valid-output accounting.
