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
| Nothing is activated that was not verified first | The orchestration, by ordering |
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
returns null, which is recorded rather than treated as success.

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
