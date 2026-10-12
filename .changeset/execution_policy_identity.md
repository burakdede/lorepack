---
'@lorepack/cli': patch
'@lorepack/runtime': patch
'@lorepack/sdk': patch
---

Identify resolved retrieval and packing policies separately from immutable
content. Context results carry deterministic policy and build-scoped selection
IDs across CLI export, HTTP/SDK, MCP and remote projections. Share canonical
hashing across Node and Worker runtimes without changing content build IDs.
