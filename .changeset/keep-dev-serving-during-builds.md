---
"@lorepack/cli": patch
---

Run watched builds in a Node worker so synchronous compilation and durable report
writes do not block dev HTTP, MCP or Studio. Preserve build identity, progress,
cancellation, validation and activation through the existing compiler pipeline.
