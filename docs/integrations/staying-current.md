# How Lorepack stays current inside a long-lived agent session

The short answer: **every result carries the build it was read from**, and the server
rechecks the sources on an interval rather than once at startup.

## Why this needs an answer at all

Under the 2026-07-28 MCP specification, an open stdio connection **is not a session**. A
coding agent may hold one process for an entire conversation, and clients are told not to
tie process lifetime to a conversation. So a server that established freshness once, at
startup, would report `sourceState: "clean"` for an hour while the documents underneath it
changed, and every answer would look exactly as authoritative as the first one.

## What actually happens

| Moment | What Lorepack does |
|---|---|
| Startup, `--ensure-current` | Reconciles before the first protocol byte: builds if the sources moved, or if there is no build yet |
| Every request | Stamps the response with the active build id and the freshness observed for that request |
| Past the revalidation interval | Cheap metadata prescreen; only if something moved does it content-hash |
| Another terminal runs `lorepack build` | Picked up at the next request, with no restart and no client action |
| A request already in flight | Finishes against the build it captured. No response mixes two builds |

## The cost, and why the interval exists

Content hashing every artifact is what dominates a no-op build. At the 50,000-chunk
envelope, on bursty agent traffic, doing that per request would be seconds of work to
annotate an answer that took milliseconds.

The active pointer and generation are checked on every read. A pointer change invalidates
freshness even when sources did not change, including rollback during the interval or with
`off`. This only checks freshness; it never rebuilds or undoes rollback.

For source changes, freshness is rechecked at most once per `--revalidate-interval` (default 5,000 ms), and
inside that check a **prescreen** looks only at paths, sizes and modification times.
Architecture 12.3 permits exactly this: metadata as a prescreen, content hashes as the
deciding evidence. A scan that finds nothing moved answers from cache. A scan that finds
something calls the real check.

```bash
lorepack mcp --ensure-current                          # recheck every 5 seconds
lorepack mcp --ensure-current --revalidate-interval 0  # recheck every request
lorepack mcp --ensure-current --revalidate-interval off # startup only, the old behaviour
lorepack mcp --follow-active                           # follow reviewed activation, never rebuild
lorepack mcp --allow-stale                             # alias for --follow-active
lorepack mcp --active-only                             # never look at the sources
```

## Freshness never fails a read

A read of a sealed build is not entitled to an opinion about the source tree. If the
sources cannot be inspected at all, the answer is `sourceState: "unknown"` and the build
still answers. This was learned the hard way: establishing freshness first once made
`lorepack search` refuse to answer on a project above the file envelope, from a build sitting
ready on disk (#147).

## Temporary source read failures

If a file disappears during a source scan, read-only freshness becomes `unknown` with the
source-read reason. The immutable build still answers. `lorepack dev` warns and continues
watching; its reconciliation queue can recover when the source becomes readable again,
even if metadata did not change. A strict `status` or build can still report the source
error, and unrelated corrupt-build errors remain errors.

[Verification](../testing/source_freshness_recovery.md) separates real read-open races,
serialized watcher recovery and the full sixty-second churn check.

## What a client should do with this

Read `buildId` and `sourceState` off any result.

- `clean`: the build matches the sources as of that request.
- `dirty`: the sources have moved on. The content is still real and still cited; it is
  simply behind.
- `unknown`: freshness could not be established. Treat it as `dirty` if it matters.

A changing `buildId` between results means activation changed, possibly through rollback.
`--ensure-current` builds only at startup. Later source changes are annotated without automatic
activation; `lorepack dev` separately watches source changes and builds them.


For `lorepack dev`, the periodic reconciliation floor covers configured subdirectories and
individual file sources even when no filesystem event arrives. Event filtering uses the
same project-relative ignore rules and directory pruning as discovery. With `sources: [docs]`,
`/docs/private/` excludes that directory; file identities remain source-relative. Changed context appears
only after a complete candidate is validated and activated; HTTP, MCP and Studio read that
immutable build. [Verification](../testing/source_watch.md) records the event-disabled tests
and the actual local CLI/HTTP check. A persistent MCP HTTP client was verified on2026-10-16
with protocol SDK2.2.0 and MCP2026-07-28; this does not claim new desktop-client trust verification.
