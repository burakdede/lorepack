# Deploying a build

A deployment projects one immutable build onto a remote runtime. It never recompiles, never
edits the build, and never activates something it has not verified.

## The port, and where the rules actually live

`DeploymentTarget` (architecture section 16.3) is seven methods: `detect`, `capabilities`,
`plan`, `apply`, `verify`, `activate`, `rollback`. Section 16.4 lists the siblings it exists for
(Docker, PostgreSQL, Lambda, Kubernetes), none of them a v0.1 deliverable, which is exactly why
the shape is fixed now: a contract written against one implementation is a description of that
implementation.

Most of 16.3's rules are enforced by the **orchestration**, not by the targets. That split is
the point. A rule a target has to remember is a rule some target will forget, and the one that
forgets will be the one written last, by someone reading a different target as an example.

| Rule | Enforced by |
|---|---|
| `plan` is read-only | The target, and asserted by a recording fixture |
| Capability loss fails by default | The orchestration: a target only *reports* loss |
| The override is per capability, never a blanket flag | The orchestration |
| `apply` writes only build-scoped candidate data | The target |
| Nothing is activated that was not verified first | The orchestration, by ordering; the Cloudflare target also refuses a build it never marked verified |
| A failed verify leaves the previous build serving | The orchestration |
| Receipts are resumable | The orchestration, from a validated schema |
| A target cannot change the build | Asserted by hashing the build around a deploy |

**A target reports; the orchestration decides.** The first version of `apply` took the target's
returned receipt wholesale, which let it erase `capabilityLossAccepted`, so a deploy that gave
up a capability recorded that it had not. The receipt is now merged: the target says what it
wrote, and the fields that are decisions stay the orchestration's.

## The sequence

Section 18.5:

```
status -> plan -> build if dirty -> project candidate -> verify -> activate -> smoke -> receipt
```

`build if dirty` belongs to the caller: deploying is not the only thing that needs it, and
`--no-build` is a statement about the caller's intent rather than about the target.

The **smoke check** is the difference between "the write returned" and "it is serving". A target
confirms by querying its own public endpoint and comparing the build id, so a pointer that was
written and not picked up is caught here rather than by a user. A target that cannot confirm
returns null, and **that fails the deploy** unless `--skip-smoke` was passed. The first version
treated null as "cannot confirm" and carried on, so a Cloudflare endpoint built without the
account subdomain never resolved and the check never fired once (#580). A plan with no endpoint
at all is refused before anything remote is written, because finding out after activation is
finding out too late. With `--skip-smoke` the receipt records the deploy as active and leaves
`smoke` out of `completedSteps`, so it never claims a check that did not run.

## Capability loss

A build declares capabilities; a target declares what it can serve. Anything in the first and
not the second is a **loss**, and a loss fails the deploy.

The override is `--allow-capability-loss <capability>`, one per capability, never a blanket
`--force`. The difference is not pedantry: `--force` becomes a habit, and a habit that silently
drops table queries from a deployment is the exact outcome capability negotiation exists to
prevent. Accepted losses are echoed into the receipt, so what was given up is on the record
rather than in someone's shell history.

## Receipts

Written under `.lore/receipts/`, validated against the committed schema on the way back in
because a receipt is a file a person can edit, and a resume driven by a malformed one would
replay the wrong steps against a live target.

Deliberately outside `builds/`: a deploy writing anything into a sealed build would make its
bytes depend on where it had been sent, which is the immutability invariant read backwards.

A **dry run writes no receipt at all**, so `--resume` never offers to continue something that
never started.

## Resuming

`completedSteps` is a closed set in a fixed order, not free strings, because `--resume` reads it
back: a receipt whose steps are whatever a target felt like writing can only be resumed by that
target. A resume skips the steps already done, so it continues rather than restarting, and
resuming a finished deploy changes nothing.

`verify` is the one step a resume cannot skip on the strength of its name alone. It is recorded
in `completedSteps` only when no check failed, and a resume skips it only when the receipt's
`verification` outcomes contain no failure. A failed verification is therefore not resumable:
the error does not offer `--resume`, and a resume run anyway verifies again and stops again
(#555). A receipt whose verification passed but whose smoke check failed after activation still
skips straight to activation, because its candidate did pass.

The remote side does not rely on the receipt. Cloudflare activation reads
`projected_builds.verified_at` inside the activation transaction and throws
`CloudflareUnverifiedBuildError` when it is NULL, leaving the pointer where it was. That covers a
receipt edited by hand and a second client sharing the catalog. Rollback is exempt: it returns
to a build that already served, and builds projected before the `verified_at` column existed
carry NULL there.

## Cloudflare endpoint and Wrangler

The Worker's public origin is `https://<worker>.<account-subdomain>.workers.dev`. The subdomain
is an account setting, so `lorepack target add cloudflare` records the origin in
`.lore/targets/cloudflare.json`: from `--endpoint` when given (an https origin, no path), or from
the Cloudflare API (`GET /accounts/:id/workers/subdomain`) when `CLOUDFLARE_API_TOKEN` is set. A
deploy uses the recorded origin, falls back to the same lookup for receipts written before #580,
and refuses when neither is available. Rollback proceeds without one, because it only moves the
pointer and is the way out of an incident.

Wrangler is never a dependency of the published CLI (it pulls native tooling, and invariant 7
rules that out). The user installs it in the project or next to lorepack, and the CLI resolves
the package named `wrangler` through Node's own algorithm, from the project first and then from
its own install. It runs Wrangler in an empty temporary directory so a `wrangler.toml` that
belongs to some other Worker in the project cannot redirect a command. In this repository the
CLI declares `wrangler` as a devDependency, which is what lets the bundled entry point find it.

## Cloudflare R2 key layout

Phase 6's Cloudflare target stores two distinct things in one bucket, so the key shape is part
of the deployment contract rather than an implementation detail:

- normalized objects: `project/objects/sha256/<hash>`
- sealed build archive: `project/builds/<buildId>/archive.lorepack`

The project id comes first in both cases because the bucket is target-owned and may hold more
than one Lorepack project. Objects are shared across builds under the project because they are
content addressed and deduplicated. The archive is build scoped because retention, rollback and
status address one sealed build at a time, and a deterministic `project/builds/<buildId>/`
prefix lets later work enumerate or remove exactly that build without guessing.

## Cloudflare remote cleanup

`lorepack prune --target cloudflare` removes builds from both D1 databases and from R2. The
catalog rows (`tables`, `table_columns` and the rest) are deleted from `CATALOG_DB`; the
projected physical tables they name are dropped from `TABLES_DB`, where projection created them
([ADR](adr-d1-table-query-isolation.md)). Physical tables are dropped first, so a failed catalog
delete still leaves the rows a resume needs to find them.

A table is reported in `physicalTablesDropped` only when `sqlite_master` listed it before the
`DROP TABLE` and no longer lists it afterwards. `DROP TABLE IF EXISTS` on its own cannot prove
anything: it succeeds on a missing table, which is how releases before #557 reported drops
that never happened while the rows stayed in `TABLES_DB`. Every name read from the catalog must
match the same `SAFE_IDENTIFIER` the table store uses before it is interpolated into SQL.

The plan also lists `orphanTablesToRemove`: tables in `TABLES_DB` that have the projected name
shape (`<prefix>_<16 hex>`) but that no catalog row references, for any build. Those are what
the earlier bug left behind. `--yes` drops them after reading the references again, so a table
a deploy claimed after the plan was printed is kept. Because a deploy creates a physical table
before it writes the catalog row for it, do not run a remote prune while a deploy to the same
target is in progress. A tables database must also belong to exactly one catalog database: the
sweep cannot see references held by a different catalog.

## Cloudflare D1 projection concurrency

Phase 6 keeps Cloudflare D1 projection writes **serial**. The current chosen concurrency is `1`:
one D1 write statement is awaited before the next begins. This is not left implicit in the code.

The checked-in probe [`benchmarks/cloudflare/projection-concurrency-2026-08-09.json`](../../benchmarks/cloudflare/projection-concurrency-2026-08-09.json)
was recorded on **Sunday, August 9, 2026** with `pnpm bench:cloudflare-projection -- --out <file>`.
It measures the current projection path with delayed write statements and records the maximum
in-flight D1 writes observed. The recorded result is `maxInflightWrites: 1`, which is the
evidence behind keeping the write path serial while D1 remains single-threaded.

The CLI's Wrangler-backed D1 adapter executes remote D1 statements from temporary `.sql` files
instead of passing projected SQL through Wrangler's `--command` flag. It also does **not**
forward explicit transaction control statements such as `BEGIN IMMEDIATE`, `COMMIT`, or
`ROLLBACK` to remote D1. Cloudflare D1 already wraps each remote statement in its own
transaction, so sending those statements through Wrangler fails before projection can begin.
Serial writes still hold because Lorepack awaits each statement in order.

If a later change proposes parallel D1 projection writes, it must replace that artifact with a
new measurement and update this section. Until then, higher concurrency would be an optimization
before measured need.

## Cloudflare table-query bounds

The Worker applies the shared table-query limits before D1 materializes a result: 100 rows by
default, 10,000 rows maximum, and a 1 MB serialized response ceiling. `D1TableStore` wraps the
validated single-table statement in an outer `LIMIT` and requests one extra row to preserve the
`truncated` flag. Slicing an unbounded D1 result after `run()` would allow a model-facing request
to allocate the whole table, so that implementation is deliberately not used.

Before any of that, the statement goes through the shared statement guard with the `remote`
profile (`docs/architecture/adr-sql-surface.md`, 2026-10-05 addendum). It is the only isolation
control on this path: D1 offers no authorizer, and `CATALOG_DB` also holds the catalog, other
builds' tables and `runtime_tokens`. The guard reads `sqlite_master` on every query and refuses
the query if it cannot. It returns the statement without comments, and the wrapper puts it on its
own lines, so nothing in the statement can reach the closing parenthesis. Because D1 cannot be
interrupted before its own 30 second limit, the remote profile also refuses recursive common
table expressions (a CTE that names itself is recursive to SQLite with or without the keyword),
`json_each` and `json_tree`, aggregates used as windows, and statements whose estimated row
product would exceed 5,000,000. The estimate counts a VALUES list by its literal rows, never by
the table's row count (#558).

That bounds rows, not what a row costs: a statement can make each row expensive with string
functions, and no static rule sees all of them. So the Worker also rate-limits table queries,
20 per 60 seconds per caller, through the `TABLE_QUERY_LIMITER` Workers Rate Limiting binding
declared in `packages/deploy-cloudflare/wrangler.jsonc`. The key is a SHA-256 of the caller's
bearer token or Access assertion. A caller past the limit gets `LORE_E_BUSY` (HTTP 429), and a
Worker deployed without the binding refuses table queries with `LORE_E_TARGET_NOT_CONFIGURED`.
Counters are per Cloudflare location and eventually consistent (Cloudflare's own description),
so the limit bounds sustained use by one token; it does not shorten a single query, which D1
can still run for up to 30 seconds. [`security.md`](security.md) states what remains open.
