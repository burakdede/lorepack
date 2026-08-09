# Cloudflare integration testing

Verified on **2026-08-08** against the current Phase 6 branch state and the checked-in
Cloudflare target setup notes in [cloudflare-target-setup.md](./cloudflare-target-setup.md).

This page defines the environment contract for `#93`, the Milestone 3 acceptance and
integration gate. It does not claim the whole remote suite is finished today. It records the
inputs, limits, visible skip behavior, and the current checked-in credentialed smoke.

## Required environment

The checked-in credential gate expects these environment variables:

- `CLOUDFLARE_API_TOKEN`: account-scoped token used by Wrangler and any direct Cloudflare API
  calls in the integration harness
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the dedicated test resources
- `LORE_CF_TEST_PREFIX`: lowercase resource prefix for this repository's integration resources

Optional CI metadata:

- `GITHUB_RUN_ID`
- `GITHUB_RUN_ATTEMPT`

When CI metadata is present, the harness derives a per-run resource prefix by appending those
numeric values. That keeps parallel runs from colliding while preserving a stable human-owned
prefix for manual cleanup and dashboard inspection.

Example:

```text
LORE_CF_TEST_PREFIX=lorepack-ci
GITHUB_RUN_ID=12345
GITHUB_RUN_ATTEMPT=2
```

This becomes the resource prefix `lorepack-ci-12345-2`.

## Token scopes

The least-privilege token shape for the current Phase 6 integration path matches the setup and
deploy surface already documented for the target receipt flow:

- `Workers Scripts Edit`
- `D1 Edit`
- `Workers R2 Storage Edit`

These are enough for the present contract because the Phase 6 path needs one Worker, one D1
database, and one R2 bucket. It does not need Zones, Pages, KV, Queues, Durable Objects,
Vectorize, or AI permissions.

## Shared corpus and acceptance shape

The remote-versus-local acceptance path must reuse the mixed corpus from
`tools/acceptance/src/mixed-corpus.ts`. This is the same folder the local Milestone 2
scenarios already drive, so any remote comparison is over one corpus rather than over a second
fixture that could drift.

The eventual `#93` suite is expected to prove:

1. `lore target add cloudflare`
2. `lore deploy cloudflare`
3. remote REST and MCP reads report the same build id as the deployed local build
4. a second deploy changes the served build id
5. remote rollback returns the earlier build id by pointer change alone

## Visible skip behavior

When the required credentials are absent, the Cloudflare integration suite skips with an
explicit message that names the missing variables. It skips with an explicit message in test
output and is not treated as a pass.

The checked-in gates today are:

- `tools/acceptance/test/cloudflare-testing.test.ts`, which verifies the environment contract,
  the resource-prefix rule, and the documented skip behavior
- `tools/acceptance/test/cloudflare-smoke.test.ts`, which provisions one Worker, one D1
  database, and one R2 bucket, deploys the checked-in Worker package, runs
  `lore target add cloudflare`, runs `lore deploy cloudflare`, edits the mixed corpus, runs a
  second `lore deploy cloudflare`, then verifies the public build id and read surface before
  and after `lore rollback --target cloudflare <buildId>` through `GET /v1/build`,
  `POST /v1/context`, and MCP `lore_search`

The broader resume, capability-loss, full auth, and CI artifact cases are still open work on
`#93`.

## Cost expectations

The current expected remote footprint per integration run is:

- one Worker script
- one D1 database
- one R2 bucket
- one projected mixed corpus build

The corpus is intentionally small. It should stay close to the existing mixed acceptance
fixture so the release-candidate gate is measured in minutes, not in large-account burn or
benchmark-scale storage churn.

## Teardown and artifacts

The final `#93` suite must delete every created Cloudflare resource at the end of the run,
even after a failed assertion, so a credentialed CI run does not leak Workers, D1 databases,
or R2 buckets.

CI artifacts for that suite must include:

- deployment receipts
- the local build id and the remote build ids observed during verification
- command logs for setup, deploy, resume, and rollback
- any generated result summary used by the acceptance gate

Those artifacts are what make a skipped run visibly different from a failing or passing one,
and what let a later session audit the exact remote state transitions that were observed.
