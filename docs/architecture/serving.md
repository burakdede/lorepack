# Serving a build

How a model reaches a build, and what the boundary refuses to do.

Everything here is a projection of one immutable build. There is no route, tool or resource
that builds, deploys, edits a source or runs a command, and there is nowhere to add one
without editing a single file per surface (invariant 10).

## One runtime, three surfaces

`LoreRuntime` is seven capabilities, declared in `@lorepack/core` and implemented in
`@lorepack/runtime`. REST, MCP and the CLI all call the same object, so a capability cannot
exist in one interface and be missing from another.

| Surface | Started by | Speaks |
|---|---|---|
| stdio MCP | `lore mcp` | MCP 2026-07-28 over stdin/stdout |
| HTTP | `lore serve` | REST under `/v1`, and MCP at `POST /mcp`, on one port |
| Process | `lore search`, `lore export` | the same runtime, in-process |

## The protocol revision, and where it is decided

**Verified 2026-08-03** against `@modelcontextprotocol/server` 2.0.0: both MCP surfaces
negotiate **2026-07-28**, and `server/discover` reports `supportedVersions:
["2026-07-28"]` on each. A request claiming any other revision is refused with
`UnsupportedProtocolVersionError` (`-32022`).

Two things about this are easy to get wrong, and both cost a defect (#188, #189).

**The SDK's `LATEST_PROTOCOL_VERSION` is not the revision this server speaks.** It is
`2025-11-25`, the newest **handshake-era** revision, kept so the SDK can answer a 2025-era
client through the `initialize` exchange that 2026-07-28 removed. Lorepack keeps that path
working, because the specification requires it: a client that only speaks the handshake
still gets the full tool surface. `packages/mcp/src/protocol.ts` is the one place the
revision is named, and `tools/contract/test/protocol-version.test.ts` fails if any other
file names a superseded one.

**Era negotiation belongs to the transport entry, not to the server object.** `serveStdio`
and `createMcpHandler` classify the opening message, choose an era, and pin one instance
from a factory. The hand-wired shape most SDK examples show, `server.connect(transport)`,
does none of that: the connection stays 2025-era and the mandatory `server/discover` probe
is answered with `Method not found` even though the handler is registered. That is exactly
how `lore mcp` shipped until #189. Anything that serves this surface over a new transport
uses an entry.

## One condition, one classification, whichever surface asks

A failure means the same thing on every surface, and each states it in its own vocabulary.
The Lorepack error code is the contract; the HTTP status and the JSON-RPC code are both
derived from it, in one place per surface (`statusFor()` in the runtime's HTTP app,
`classify()` in the MCP resources).

| Condition | Lorepack code | REST | MCP |
|---|---|---|---|
| The build has no such document or build | `LORE_E_BUILD_NOT_FOUND` | 404 | `-32602` |
| The request is malformed | `LORE_E_INVALID_ARGUMENT` | 400 | `-32602` |
| The server genuinely broke | anything else | 500 | `-32603` |

The two surfaces disagreed until #191: MCP let every failure fall through to `-32603`
INTERNAL_ERROR, so a client asking for a document that was never in the build was told the
*server* had broken. That is the difference between an agent correcting its URI and an agent
giving up, and it is why the mapping is derived from the code rather than written per
handler.

`-32603` is narrowed by this, not removed. A runtime that throws something Lorepack never
classified still reports an internal error, because that is what it is.

## Worker D1 query budget

Verified on **2026-08-08** against the Phase 6 Worker fixture in
`packages/deploy-cloudflare/test/query-budget.test.ts`.

The Phase 6 Worker is intentionally **stateless**: each request reads the active build through D1
and R2 directly, with no Durable Object in the path. The design reason is recorded in
`docs/architecture/adr-cloudflare-worker-stateless.md`.

The bound that matters is **D1 queries per runtime request**, because the Worker also spends
one query acquiring the active build pointer before every capability. The current read path
stays well under the 50-query free-tier ceiling even on its fallback path:

| Capability | Maximum D1 queries | Why |
|---|---:|---|
| `describeBuild` | 4 | active-build pointer, projection-state check, projected manifest lookup, warning count |
| `search` | 6 | pointer, projection-state check, precise FTS search, fallback FTS search when precise is empty, superseded ids, chunk count |
| `contextForTask` | 5 | pointer, projection-state check, precise FTS search, fallback FTS search when precise is empty, superseded ids |
| `readSource` | 4 | pointer, projection-state check, artifact lookup, node lookup. The body is in R2 |
| `listTables` | 3 | pointer, projection-state check, table listing |
| `describeTable` | 5 | pointer, projection-state check, table lookup, column lookup, sample rows |
| `queryTable` | 5 | pointer, projection-state check, table lookup, column lookup, table query |

Two details keep these counts fixed rather than proportional to result size:

- `contextForTask` ranks and assembles from one FTS result set instead of fetching per-hit
  metadata. A deeper candidate list costs bytes, not round trips.
- `readSource` resolves a range through node rows and reads the normalized body from R2, so
  the Worker does not spend D1 queries on full document text.
- Every capability checks `projected_builds` at the request boundary before opening the
  projected namespace, so an older or newer projection fails with `LORE_E_SCHEMA_MISMATCH`
  rather than surfacing as a missing column or table from inside a later query.

## MCP resources

Tools are for what a client wants to ask; resources are for what it wants to browse
(architecture 14.2). Three fixed URIs and two templates:

```text
lore://project/build
lore://project/sources
lore://project/tables
lore://source/{artifactId}
lore://build/{buildId}/diff/{otherBuildId}
```

The diff resource is the one that does not come from `LoreRuntime`, and it is worth knowing
why. Every runtime capability reads the **active** build through one handle. A diff reads
two builds, neither of which need be active, from build records alone, which is what makes
it work after the sources have moved on. So it is a separate optional port, `BuildComparer`,
supplied by the host: `lore mcp` and `lore serve` both supply the local one, and a
deployment that holds only the build it serves supplies none.

That deployment still lists the resource and answers with a typed error explaining it
cannot compare two builds. A surface that changes shape depending on where it is running is
a surface a client has to probe.

## The HTTP surface

| Route | |
|---|---|
| `GET /health` | build id, generation, freshness. No content from the build |
| `GET /v1/build` | what the active build contains |
| `POST /v1/search` | ranked passages with locators |
| `POST /v1/context` | a bounded, cited bundle for a task |
| `GET /v1/sources/:artifactId` | one document, whole or by range |
| `GET /v1/tables`, `GET /v1/tables/:id`, `POST /v1/tables/:id/query` | typed tables |
| `ALL /mcp` | MCP Streamable HTTP, when a handler is mounted |

Anything else is a `404` in the same typed error shape as every other failure, so a client
has one error format rather than two.

Five more routes exist only where the host supplied them, because each reads something a
deployment does not have. `GET /v1/plan` walks the source tree; `GET /v1/warnings` and
`GET /v1/sources` read the active build's catalog; `POST /v1/export` renders the Markdown
`lore export` writes; `GET /v1/diagnostics` reads the machine. `lore serve` registers only
the three that read the active build, because the other two read sources and a live session,
and `lore serve` has neither.

`/v1/diagnostics` returns the same report `lore doctor --json` prints, validated against
`schemas/doctor-report.json`, plus the live session state a one-shot command cannot see: the
watcher, the port, the process, and which clients are configured. It is an injected host
function rather than a runtime capability, for the same reason `currentBuild` is: architecture
13.1 fixes `LoreRuntime` at seven capabilities that read a *build*, and a diagnostic reads the
machine.

### The write surface

The only routes in this API that change anything:

| Route | |
|---|---|
| `GET /v1/builds` | every build in the project, with the active one marked |
| `GET /v1/builds/:from/diff/:to` | section 18.3's comparison of any two builds |
| `POST /v1/builds/activate` | move the active pointer to a named build |
| `POST /v1/builds/rollback` | move it back to the previous verified build |
| `POST /v1/builds/pack` | write a `.lorepack` archive |

They exist only where a host passes `localActions`, which only the local CLI does, and only
for `lore dev`. Three things keep them local:

1. **A remote deployment cannot register them.** It holds one build and no history, so it has
   nothing to supply. A route that does not exist cannot be reached by getting past a check.
2. **They refuse any browser origin that is not a loopback literal**, and `allowedOrigins`
   cannot widen this. Adding a remote origin so a team can read a deployment is not the same
   as letting it activate a build.
3. **No model-facing tool reaches them.** MCP stays read-only (invariant 10). These are
   Studio's, and Studio is served from loopback.

Each one calls the same code path the equivalent command does, so a build activated in a
browser and one activated in a terminal are the same operation with the same pre-flight and
the same lock. Activation checks the target build opens and passes its integrity check
*before* the pointer moves, so a corrupt build fails with the previous one still serving.

`POST /v1/builds/rollback` accepts an optional `expect`, the build id the caller was shown
before confirming. If the history moved in between, the request is refused rather than
applied to a different build than the one that was confirmed.

### Origin checking

A page on any website can make a request to `127.0.0.1`, and DNS rebinding can make it look
same-origin to the browser. Every unrecognised `Origin` is refused. A non-browser client
(the SDK, an MCP host, curl) sends no `Origin` header and is unaffected. `/health` is exempt
so a browser can probe liveness without learning anything.

### Authorization

`createApiApp` takes an optional `authorize` hook that runs before every route except
`/health`:

```ts
createApiApp({
  runtime,
  currentBuild,
  authorize: ({ authorization }) =>
    authorization === `Bearer ${expected}` || 'This token is not valid for this build.',
});
```

Returning `true` admits the request; `false` or a reason refuses it as `401`, with the
reason as the error message. The decision may be asynchronous, because a real check calls
something.

On `/mcp`, the standard Streamable HTTP headers are validated against the parsed JSON-RPC
body **before** the hook runs. `Mcp-Method` must agree with `body.method`, and `Mcp-Name`
must agree with `params.name` or `params.uri` on the methods that mirror one. A divergence is
rejected as HTTP `400` with MCP error `-32020` (`HeaderMismatch`). That is what makes those
headers safe to use as a routing hint in Cloudflare Access or WAF policy: the body remains the
source of truth, and a forged header is refused before an authorization decision can trust it.

**No hook is passed locally, and that is deliberate.** A loopback server can only be reached
by the person who started it, and a token they issue to themselves protects nothing while
adding something to get wrong. The hook exists for the remote target in Phase 6, which is
the case where the network is not the boundary. It lives in the middleware rather than in
each route so that a route added later is protected by existing, not by its author
remembering.

## Freshness travels with the answer

Every response carries the build id it was read from and a `sourceState` of `clean`, `dirty`
or `unknown`. It is an annotation, never a precondition: a read of a sealed build is not
entitled to an opinion about the source tree, and refusing to answer because freshness could
not be established is how `lore search` once became useless on a large project (#147).

Activation is observed at the next request. Nothing is cached across requests, no session
holds a build open, and no response ever mixes rows from two builds: the runtime asserts the
scope it opened against the handle it acquired before reading anything.

### Freshness is a claim about one build, so the pointer invalidates it

`clean` never means "the sources are clean". It means "the sources match **this** build", and
the two come apart the moment the pointer moves without a file changing, which is exactly what
an activation or a rollback is.

Under `lore dev` the answer comes from the watcher rather than from the polling revalidator,
because a supervisor that is already watching knows without paying for a scan. That answer is
cached, and the cache is keyed on filesystem events, which an activation does not produce. So
rolling back in Studio left the server reporting the freshness of the build that had just
stopped being active: the header read "the sources match this build" about the state the
reader had deliberately left (#200).

The watcher now records freshness together with the build it describes. When a read finds the
pointer has moved, it reports `unknown` immediately and queues the re-establishment, because:

- **`unknown` is honest and `clean` is invented.** Invariant 6 applies to the degraded case as
  much as to the normal one.
- **Establishing freshness walks and hashes the corpus**, and `/v1/build` is on the request
  path of every Studio poll and every MCP call. It does not belong there.
- **The recompute must not rebuild.** Rolling back to an older build makes the sources dirty by
  definition, and treating that as a reason to build would activate a new build and undo the
  rollback the reader just asked for. The re-establishment path is deliberately separate from
  the settle path for that reason, and a test asserts the rebuild callback is never called.

This also covers the case nobody wired: `lore activate` run in a second terminal against a
live dev session moves the same pointer, and is noticed the same way.
