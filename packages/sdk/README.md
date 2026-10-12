# @lorepack/sdk

A typed client for a Lorepack runtime. No dependencies.

```bash
npm install @lorepack/sdk
```

`fetch` is standard in Node 24 and in Workers, so this package installs anywhere and adds
nothing to your supply chain. It is read-only, because the server is: nothing here can
build, deploy or edit anything.

## Ten lines

Search and task context are current-only by default. Archived and declared superseded
bodies require `includeArchived: true`; a historical-only match leaves the default
selection empty. Default context reports their omitted locators without delivering their
text. Drafts remain eligible and labeled. Explicit historical results also keep labels
and provenance. Direct source reads addressed by path or ID remain available.

```ts
import { LoreClient } from '@lorepack/sdk';

const lore = new LoreClient({ baseUrl: 'http://127.0.0.1:4321' });

const build = await lore.describeBuild();
console.log(`${build.projectName} at ${build.shortBuildId}, ${build.counts.chunks} chunks`);

const bundle = await lore.contextForTask({ task: 'how do I roll back a release' });
for (const citation of bundle.citations) {
  console.log(`${citation.relativePath}:${citation.lineStart ?? 1}`);
}
```

Build descriptions, search results, context bundles, source reads, table descriptions and
table query results carry `corpusId`, `namespaceId`, `buildId` and `sourceState`. Corpus and
namespace are persistent operational identifiers; the digest identifies immutable content
and freshness reports whether sources have moved on. IDs are not credentials. Health reports server status. Selected table listings also carry build, corpus and namespace IDs.
Unselected table listings retain their existing shape.

## Selected retained builds

Set `buildId` to a full build ID when creating `LoreClient` to keep all seven read capabilities
on that version across activation changes. Search, context, source and query requests can
override the client selection with their own `buildId`. Missing or unavailable versions fail
with `LORE_E_BUILD_NOT_FOUND`; the client refuses a successful response with missing or
different build proof as `LORE_E_SCHEMA_MISMATCH`, including an older server that ignores
selection. Health is a server probe and is not selected by the client.

```ts
const selected = new LoreClient({ baseUrl: 'http://127.0.0.1:4321', buildId: build.buildId });
const bundle = await selected.contextForTask({ task: 'rollback procedure' });
```

## Methods

| Method | Route |
|---|---|
| `health()` | `GET /health` |
| `describeBuild()` | `GET /v1/build` |
| `search(request)` | `POST /v1/search` |
| `contextForTask(request)` | `POST /v1/context` |
| `contextForTaskWithReceipt(request)` | `POST /v1/context` |
| `readSource(artifactId, options)` | `GET /v1/sources/:artifactId` |
| `listTables()` | `GET /v1/tables` |
| `describeTable(tableId)` | `GET /v1/tables/:tableId` |
| `queryTable(tableId, sql)` | `POST /v1/tables/:tableId/query` |

Table methods require a build with the `table-query` capability.

## Options

```ts
new LoreClient({
  baseUrl: 'http://127.0.0.1:4321',
  token: process.env.LORE_TOKEN,  // sent as `Authorization: Bearer`
  timeoutMs: 30_000,
  retries: 3,                      // GETs only
  fetch: myFetch,                  // for tests, or a host with its own
});
```

Every method takes an optional `AbortSignal` as its last argument, composed with the
client's own timeout.

## Errors

Failures throw `LoreClientError`, carrying the server's stable `code`, its `message`, the
`remediation` a human should read, and the HTTP `status`. Branch on `code`: it is the
contract, and the status is a courtesy for tools that only speak HTTP.

```ts
import { LoreClientError } from '@lorepack/sdk';

try {
  await lore.readSource('guides/missing.md');
} catch (error) {
  if (error instanceof LoreClientError && error.code === 'LORE_E_BUILD_NOT_FOUND') {
    // The build does not contain that artifact.
  }
}
```

Only idempotent GETs are retried, with bounded exponential backoff, and only when the
request never reached a server. A response the server produced is returned as it is: asking
again more slowly will not turn a rejected request into an accepted one.

## Versioning

The types here mirror the server's published contracts. `tools/contract` asserts they are
identical, so a change on either side fails to compile in CI rather than surprising you at
runtime. Contract changes follow `formatVersion`: a new major of this package accompanies a
`formatVersion` bump, and additive fields arrive in minors.

Task context includes `execution.policyId`, `execution.selectionId` and their resolved
policy/request descriptors. Equivalent defaults agree across local and remote runtimes;
corpus bindings remain part of selection identity. These IDs describe context selection.
They do not retain emitted bytes or promise downstream model-answer replay. See the
[execution contract](../../docs/architecture/retrieval.md#execution-identity).

## Detached context receipts

`contextForTaskWithReceipt` opts into a detached receipt and returns `{ bundle, receipt,
payload }`. It verifies the exact HTTP response text against the receipt, captured build,
resolved policy and selection using standard Web Crypto. Missing metadata, unsupported
receipt versions or changed bytes fail with `LORE_E_SCHEMA_MISMATCH`; POSTs are never retried.
Save `payload` unchanged alongside the receipt. Re-serializing `bundle` can change its bytes.

```ts
const { bundle, receipt, payload } = await lore.contextForTaskWithReceipt({ task: 'rollback' });
```

Request text is redacted from the receipt by default. Set `receipt: { captureRequest: true }`
to retain the normalized request explicitly. The server stores neither the receipt nor its
payload. Integrity hashes are not authentication or proof that a downstream model consumed
these bytes. See [the receipt contract](../../docs/architecture/context_receipts.md).
