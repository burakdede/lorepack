# Generic MCP clients

Use this guide for any MCP client that can launch a stdio server with an executable and argument
array.

Verified on **2026-08-03** against `@modelcontextprotocol/server` 2.0.0 and MCP protocol
**2026-07-28**. This generic page was checked on **2026-08-13** against the current Lorepack
CLI command surface.

## Connection proof

`lorepack connect` checks the server's build ID against the intended project's active build,
then reads a known source pinned to that build. The check compares the citation, bounded
text and explicit truncation with an independent immutable-build read. A wrong build, missing
readable context or failed read fails verification; JSON output includes build ID and citation
on success, without source text. Verified snippets use the same check and return a nonzero
CLI exit code on failure.

The expectation is read after the server's existing `--ensure-current` startup. The same
canonical content can have the same build ID in different directories. This verifies build
content and provenance, rather than physical path identity. Client trust remains a separate
step. Automated server regressions ran on macOS on 2026-10-16 with Node 24.21.0 and
`@modelcontextprotocol/client` 2.2.0;
this change does not update the external-client verification versions and dates recorded here.

## Minimal stdio configuration

`lore_search` and `lore_context_for_task` exclude archived and declared superseded bodies
unless their arguments explicitly set `includeArchived: true`. No current match produces
an empty selection, without historical text in default alternatives. Drafts remain
eligible and labeled. Historical expansion and explicitly addressed source reads preserve
the original labels and locators; Lorepack does not choose which document is true.

Configure the client to run:

```json
{
  "command": "lorepack",
  "args": ["mcp", "--project", "/absolute/path/to/project", "--ensure-current"]
}
```

Use an argument array. Do not concatenate a shell string. Paths with spaces and Windows drive
letters remain unambiguous only when the client passes argv directly.

## Scope implications

Prefer project or workspace scope when the client supports it. User scope makes one corpus
visible to every project the client opens, which is rarely the safe default for private context.

`--follow-active` serves the approved active build without rebuilding, checks freshness on the
configured interval, and follows later activation or rollback. `--allow-stale` is its alias.
For reviewed releases choose this mode explicitly; bare `mcp` retains development startup.

`--ensure-current` asks `lorepack mcp` to rebuild when sources changed. Use `--active-only` only
when the client must avoid checking the source tree. It follows the active pointer.
Use `--build lore_<64-hex-digest>` to select one retained build across the whole server,
including tools and resources. Selection implies source-free startup and rejects
`--ensure-current`, `--follow-active` or `--allow-stale`. A tool cannot override a server selection.

On an ordinary local or remote server, every read tool accepts an optional full `buildId`.
Selected resources use `lore://build/{buildId}`, `lore://build/{buildId}/source/{artifactId}`
and `lore://build/{buildId}/tables`. Missing selections fail without reading the active build. Table listings from
`lore_list_tables`, `lore://project/tables` and the selected tables resource include
`corpusId`, `namespaceId`, `buildId`, `sourceState` and `tables`, including empty lists.
The identity and table names come from one captured build, so activation during a read
cannot change that response's identity. This table-list contract was checked on
2026-10-15 with Node 24.21.0 and MCP client/server 2.0.0 through actual CLI stdio,
and with Wrangler 4.149.0 through local Worker D1/R2 emulation.

## Protocol behavior

The stdio server is read-only at the model boundary. It exposes tools and resources that read
the active build and returns typed errors for unsupported protocol revisions. It has no tool for
build, deploy, source edits, activation, rollback or shell execution.

Every result carries provenance through `SourceLocator`. A client that drops locators is losing
contract data.

`lore_query_table` also returns `queryId`, `tableId` and `provenancePrecision: "table"`.
The locator covers the source table, not individual returned rows or aggregate cells.
Keep the submitted SQL and limit to replay the request against its returned `buildId`.
The [query identity contract](../adr/0014-table-query-identity.md) defines the fingerprint.

## Shutdown

Closing stdin ends the connection and releases the transport and retained build handles.
On macOS and Linux, SIGTERM and SIGINT follow that same shutdown path even when stdin
remains open. Shutdown listeners are removed after the connection finishes.

On Windows, Ctrl-C can deliver SIGINT to JavaScript, but sending SIGTERM or SIGINT through
Node's child-process API forcibly terminates the process. That termination does not prove
JavaScript cleanup ran. See [Node signal behavior](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events).

## Troubleshooting

| Symptom | Check |
|---|---|
| The client lists no Lorepack tools | Confirm the project or workspace configuration is trusted by the client. |
| The server fails to start | Run `lorepack mcp --project /absolute/path --ensure-current` manually from the same shell. |
| The client cannot find `lorepack` | Use an absolute command path or fix the client's PATH. |
| The server reports stale sources | Use `--ensure-current`, or run `lorepack build` before connecting. |
| The client rejects the protocol | Check that it supports MCP 2026-07-28 or the handshake-era compatibility path. |

## Verified against

MCP protocol 2026-07-28, `@modelcontextprotocol/server` 2.0.0, verified 2026-08-03. Generic
stdio configuration page checked 2026-08-13.

Task context tool results include `execution.policyId`, `execution.selectionId` and their
resolved policy and build-scoped request. They identify context selection separately from
immutable content. See the [execution contract](../architecture/retrieval.md#execution-identity)
for canonical hashing, excluded observation state and replay limits.


Context delivery was verified on 2026-10-12 with `@modelcontextprotocol/server` 2.0.0.
The budget covers the complete tool result, including both `content` text and
`structuredContent`. Exact omission totals remain in `omissionSummary`; `omitted` is
bounded diagnostic detail with explicit reported/truncated fields. UTF-8 engineering
estimates are not provider token counts. See [delivery limits](../architecture/retrieval.md#delivered-context-limits).

Context items identify their complete canonical native nodes in `nativeUnit`.
Attached conditions inside those nodes are preserved. An unresolved or oversized
native body is reported with omission reason `structural-unit`; budget omission
also removes whole units. This is structural closure, without inferred links across
paragraphs or documents. The resolved packing policy records the native body limit.

## Browse documents without a search query

Call `lore_list_sources` with `{ "limit": 50 }`. Every entry has a source locator.
If `nextOffset` is non-null, repeat with that offset and the returned full `buildId`.
Read a listed document with `lore_read_source`, its `locator.artifactId`, and the same
`buildId`. Activation between calls does not change the selected immutable content.
`lore://project/sources` returns the first page and documents this continuation flow.

This source-inventory contract was checked on 2026-10-15 with Node 24.21.0,
MCP client/server 2.0.0 over the actual CLI stdio transport, and Wrangler 4.149.0
through local Worker D1/R2 emulation. This is local integration proof; it does not
replace the credentialed release deployment checks.
