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
