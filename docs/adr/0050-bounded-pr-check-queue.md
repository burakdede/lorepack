# ADR 0050: Bound hosted PR check concurrency

Status: Accepted

## Context

The CI and benchmark workflows used separate concurrency groups scoped to each ref. Checks
for different pull requests could fan out at the same time, while a newer run for one ref
could replace that ref's pending run. Hosted runner acquisition has failed in a prior cohort,
although later overlapping runs also showed product and policy failures. The repository
needs to bound its own runner demand without hiding or replacing queued checks.

## Decision

The CI and benchmark workflows use the same workflow-level concurrency group with
`queue: max` and `cancel-in-progress: false`. This allows one workflow run at a time across
both workflows and retains up to 100 pending runs. The OS matrix within the active workflow
remains parallel. A regression test checks that both workflows use the same queue policy.

## Consequences

Pull request feedback can wait longer because whole workflow runs are serialized. Pending
checks are not replaced, but GitHub cancels additional runs when the 100-run queue is full.
The policy reduces repository-driven fan-out; it cannot guarantee hosted runner availability
or prevent transient runner-service failures. Two complete post-change matrices must record
runner acquisition, queue wait and time-to-green before issue #823 is considered verified.
