# @lorepack/sdk

A typed client for a Lorepack runtime. No dependencies.

```bash
npm install @lorepack/sdk
```

`fetch` is standard in Node 24 and in Workers, so this package installs anywhere and adds
nothing to your supply chain. It is read-only, because the server is: nothing here can
build, deploy or edit anything.

## Ten lines

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

Every response carries the `buildId` it was read from and the `sourceState` observed at that
moment, so an agent always knows which version of the corpus it is holding and whether the
sources have moved on.

## Methods

| Method | Route |
|---|---|
| `health()` | `GET /health` |
| `describeBuild()` | `GET /v1/build` |
| `search(request)` | `POST /v1/search` |
| `contextForTask(request)` | `POST /v1/context` |
| `readSource(artifactId, options)` | `GET /v1/sources/:artifactId` |
| `listTables()` | `GET /v1/tables` |
| `describeTable(tableId)` | `GET /v1/tables/:tableId` |
| `queryTable(tableId, sql)` | `POST /v1/tables/:tableId/query` |

Table methods answer as a build without tables until typed tables land in Phase 5.

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
