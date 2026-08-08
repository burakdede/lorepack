# ADR: why the Phase 6 Worker stays stateless

**Status**: accepted, 2026-08-08. Resolves the Phase 6 design question in #86.

**Decision**: the Cloudflare reference runtime is one ordinary Worker that reads the active build
through D1 and R2 on every request. It does **not** use Durable Objects.

## What the runtime actually has to do

Phase 6 is a **projection** of one immutable build. The Worker has to answer the same seven
read-only `LoreRuntime` capabilities the local runtime answers:

- `describeBuild`
- `search`
- `contextForTask`
- `readSource`
- `listTables`
- `describeTable`
- `queryTable`

Every one of those is a request-scoped read. None requires cross-request coordination, a
long-lived session, in-memory caching for correctness, or a write path at the AI boundary.

That matters because Durable Objects are not a neutral transport detail. They are a second
stateful runtime with their own lifecycle, placement, and consistency model. Adding one would be
adding a second source of truth unless the design can prove otherwise.

## Why Durable Objects are the wrong primitive here

Three Phase 6 invariants decide this.

**The build is the source of truth.** The Worker already reads the active pointer and the
projected metadata from D1, and document bodies from R2. Introducing a Durable Object for the
same answers would create a mutable cache or coordinator that the product does not need. If the
object ever disagreed with D1 or R2, the runtime would have two authorities for the same build.

**Activation is a pointer change.** Roll forward and rollback are about changing which immutable
build is active, not about mutating live session state. The correct remote read path is therefore
"open the pointer, then read that build", exactly as the local runtime does. A Durable Object
would not remove that requirement. At best it would re-read the same pointer on behalf of the
Worker, which is duplication rather than simplification.

**The AI boundary is read-only.** No model-facing route or tool may build, deploy, activate, or
run commands. The one class of problem a Durable Object often solves is serialized mutation.
Phase 6 intentionally excludes that class from the remote surface.

## Why "it could cache" is not enough

Durable Objects could cache an active build id or precomputed query results. That is not a reason
to adopt them.

The current Worker query budget is already bounded and verified in
`packages/deploy-cloudflare/test/query-budget.test.ts`, and the counts stay well below D1's
free-tier ceiling. A stateful cache would therefore be an optimization before a measured need,
which the repository rules forbid.

It would also weaken the runtime story:

- cache invalidation would become part of activation correctness
- cold start and object placement would become part of latency behavior
- test fixtures would need a second remote store and a second failure mode
- the "one build, one projection" design would now depend on process-local memory

That is more system for no Phase 6 requirement gained.

## What this does not forbid later

This ADR is about the **reference runtime for v0.1**. It does not claim Durable Objects are never
useful on Cloudflare. A future feature that genuinely needs cross-request coordination, such as
lease management or rate shaping across many Workers, can propose them on its own merits.

That future work would need a new ADR that answers two questions explicitly:

1. What state exists that D1 and R2 cannot already represent truthfully?
2. How does the design avoid turning a mutable coordinator into a second authority for build
   selection or content?

Until there is a measured requirement with those answers, the Worker remains stateless.
