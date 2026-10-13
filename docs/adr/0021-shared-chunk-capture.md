# Initialize native capture before shared bundle chunks

## Status

Accepted, 2026-10-13. Issue #700. Complete campaign qualification remains open.

## Context

The ordinary CLI recipe emits shared ESM chunks to preserve lazy protocol loading.
A collector banner on every output initializes capture repeatedly. An entry banner
also runs after its static dependencies, allowing owned shared code to execute
before capture starts. A real compiler fixture with a shared owned module reproduces
the duplicate-registration failure.

## Decision

Bundle instrumented code with the ordinary recipe without collector banners.
Keep each public entry filename as an ESM wrapper. Its first dependency initializes
capture; its second reexports and evaluates the corresponding measured body.
All wrappers share one initialization module, so Node's module cache establishes
one collector per process before owned dependencies evaluate.

Launch receipts bind every emitted JavaScript file and source map, including shared
chunks, measured bodies and initialization. Validate that graph before the CLI
runs and before campaign registration. Preserve ordinary child filenames, relative
asset paths, IPC, heap restrictions and exit behavior.

## Consequences

Measurement has additional wrappers and receipts; ordinary published artifacts do
not change. The shared-module regression must verify actual child execution and
reject stale wrappers, bodies, chunks and initialization. Passing this fixture
qualifies the builder behavior, not the original complete coverage targets.
