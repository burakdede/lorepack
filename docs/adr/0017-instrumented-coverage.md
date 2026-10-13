# Instrument direct coverage without shrinking scope

## Status

Accepted, 2026-10-13. Issue #700, COVERAGE/F15.

## Context

The complete V8 campaign passed its tests but produced an impossible negative
implicit-else count in the export command. Clamping that count would invent
measurement evidence. Standard Istanbul measures the branch directly, but
its bundled visitor omits private methods and source-map remapping drops
type-only and barrel files with no executable counters.

## Decision

Use Istanbul 4.1.11 for direct Vitest and source-layout campaign coverage,
pinned to the same version as Vitest. Apply a reproducible pnpm dependency
patch: cover ClassPrivateMethod with the existing function visitor, and retain
genuine empty source maps after remapping. The patch creates no hits or
replacement counters. Keep actual used/unused/async and empty-source regression
fixtures in the architecture suite and strict audit typecheck.

Expose that same pinned factory and remapper through the dependency patch for
native-capture qualification. Reusing its engine avoids a second independently
versioned instrumenter. An actual Node execution fixture verifies default
initializer counts, unused private methods and statements after an early throw.
These primitives do not yet qualify the complete subprocess capture pipeline.

Retain default-export expression statements with the existing statement-counter
mechanism. The standard visitor ignores those expressions; accepting empty maps
for the configuration files would discard their previously measured statements.
Leave default-export declarations and genuine type-only/barrel records unchanged.

Preserve every owned source and the original overall 95/95/95/90 and critical
98/98/95/95 targets. Keep V8's pinned native conversion primitives until a
common native instrumentation layout is qualified. Reject incompatible maps;
never add their counters together or treat missing execution as permission to
drop sources. Record static inventory comparisons separately from executed hits.

## Consequences

Direct branch measurement no longer depends on subtracting incompatible V8
ranges. Static comparison retains all 354 direct source records, preserves
every previous function line range and reduces no file's counter scope.
The separate 17 configuration files and compiled subprocess execution remain
capture obligations. Focused green tests do not close the release coverage gate.

The patch is contributor-only and requires no install script. Reevaluate it on
each provider upgrade and remove it when the unmodified provider passes the same
regressions. Published runtime dependencies and first-run requirements are unchanged.
