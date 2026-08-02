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
| Another terminal runs `lore build` | Picked up at the next request, with no restart and no client action |
| A request already in flight | Finishes against the build it captured. No response mixes two builds |

## The cost, and why the interval exists

Content hashing every artifact is what dominates a no-op build. At the 50,000-chunk
envelope, on bursty agent traffic, doing that per request would be seconds of work to
annotate an answer that took milliseconds.

So freshness is rechecked at most once per `--revalidate-interval` (default 5,000 ms), and
inside that check a **prescreen** looks only at paths, sizes and modification times.
Architecture 12.3 permits exactly this: metadata as a prescreen, content hashes as the
deciding evidence. A scan that finds nothing moved answers from cache. A scan that finds
something calls the real check.

```bash
lore mcp --ensure-current                          # recheck every 5 seconds
lore mcp --ensure-current --revalidate-interval 0  # recheck every request
lore mcp --ensure-current --revalidate-interval off # startup only, the old behaviour
lore mcp --allow-stale                             # serve as-is, label every result dirty
lore mcp --active-only                             # never look at the sources
```

## Freshness never fails a read

A read of a sealed build is not entitled to an opinion about the source tree. If the
sources cannot be inspected at all, the answer is `sourceState: "unknown"` and the build
still answers. This was learned the hard way: establishing freshness first once made
`lore search` refuse to answer on a project above the file envelope, from a build sitting
ready on disk (#147).

## What a client should do with this

Read `buildId` and `sourceState` off any result.

- `clean`: the build matches the sources as of that request.
- `dirty`: the sources have moved on. The content is still real and still cited; it is
  simply behind.
- `unknown`: freshness could not be established. Treat it as `dirty` if it matters.

A changing `buildId` between two results means the project was rebuilt between them, which
is normal and is exactly what makes the answers current.
