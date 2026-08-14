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
- `LORE_CF_ARTIFACT_DIR`

When CI metadata is present, the harness derives a per-run resource prefix by appending those
numeric values. It prepends that prefix to the smoke project name before
`lore target add cloudflare`, so the CLI's own deterministic default names stay aligned with the
acceptance harness. That keeps parallel runs from colliding while preserving a stable human-owned
prefix for manual cleanup and dashboard inspection.

Example:

```text
LORE_CF_TEST_PREFIX=lorepack-ci
GITHUB_RUN_ID=12345
GITHUB_RUN_ATTEMPT=2
```

This becomes the resource prefix `lorepack-ci-12345-2`.

When `LORE_CF_ARTIFACT_DIR` is set, the credentialed smoke writes machine-readable command
logs, deployment receipts, and a remote summary into that directory so CI can upload them as
artifacts even when the run later fails during verification or teardown.

Even when credentials are absent and the credentialed smoke skips, the acceptance tests now
write summary JSON files into `LORE_CF_ARTIFACT_DIR` so CI still uploads a visible Cloudflare
artifact explaining that the run was a skip rather than a pass.

## Where this environment must exist

The expected primary home for these credentials is the checked-in GitHub Actions job
`cloudflare acceptance (ubuntu-latest)` in `.github/workflows/ci.yml`. That is the Phase 6
lane that must eventually stop skipping and start producing credentialed remote artifacts for
`#93`.

If repository secrets are intentionally unavailable on a given branch or release candidate,
the same variables must exist in another documented release-candidate environment before Phase 6
can close. A local shell is useful for debugging, but it is not sufficient closure evidence for
this phase because `#93` requires uploaded receipts and remote summaries from the acceptance
lane.

## Token scopes

The least-privilege token shape for the current Phase 6 integration path matches the setup and
deploy surface already documented for the target receipt flow:

- `Workers Scripts Edit`
- `D1 Edit`
- `Workers R2 Storage Edit`

These are enough for the present contract because the Phase 6 path needs one Worker, one D1
database, and one R2 bucket. It does not need Zones, Pages, KV, Queues, Durable Objects,
Vectorize, or AI permissions.

The credentialed smoke also lists D1 databases and deletes stale catalog databases whose names
match `LORE_CF_TEST_PREFIX-<older-run>-<attempt>-...-catalog`. This is deliberately limited to
older CI run ids or earlier attempts for the same run, so it does not delete the current run or a
newer parallel run. The cleanup exists because leaked D1 databases can exhaust the account quota
before `lore target add cloudflare` reaches the deploy path.

## Shared corpus and acceptance shape

The remote-versus-local acceptance path must reuse the mixed corpus from
`tools/acceptance/src/mixed-corpus.ts`. This is the same folder the local Milestone 2
scenarios already drive, so any remote comparison is over one corpus rather than over a second
fixture that could drift.

The eventual `#93` suite is expected to prove:

1. `lore target add cloudflare`
2. `lore target token cloudflare`
3. `lore deploy cloudflare`
4. remote REST and MCP reads report the same build id as the deployed local build
5. a second deploy changes the served build id
6. remote rollback returns the earlier build id by pointer change alone

The checked-in smoke now generates a runtime bearer token after `lore target add cloudflare`
and passes it through `LORE_REMOTE_BEARER_TOKEN` for deploy and rollback confirmation, and as
`Authorization: Bearer <token>` for direct `GET /v1/build`, `POST /v1/context`, and `POST /mcp`
verification calls.

The same smoke now also proves the rejection side of that contract: an unauthenticated
`GET /v1/build` returns `401`, an unauthenticated MCP `POST /mcp` returns `401`, and a
wrong runtime bearer token is rejected without being echoed back in the response body.

## Visible skip behavior

When the required credentials are absent, the Cloudflare integration suite skips with an
explicit message that names the missing variables. It skips with an explicit message in test
output and is not treated as a pass.

The checked-in gates today are:

- `packages/deploy-cloudflare/test/runtime-contract.test.ts`, which now runs the shared
  Phase 2 runtime contract against a real projected Cloudflare fixture backed by the
  package's D1 and R2 ports rather than a hand-wired query fake, including the activation
  invariant
- `tools/acceptance/test/cloudflare-testing.test.ts`, which verifies the environment contract,
  the resource-prefix rule, and the documented skip behavior
- `tools/acceptance/test/cloudflare-smoke.test.ts`, which provisions one Worker, one D1
  runtime plus target resources, runs `lore target add cloudflare` in automatic provisioning
  mode so the command itself creates the D1 database and R2 bucket, then deploys the checked-in
  Worker package, runs `lore target token cloudflare`, runs
  `lore deploy cloudflare`, edits the mixed corpus, runs a second `lore deploy cloudflare`,
  proves unauthenticated REST and MCP requests are rejected while the issued runtime token
  succeeds, then verifies the public build id and read surface before and after
  `lore rollback --target cloudflare <buildId>` through `GET /v1/build`,
  `POST /v1/context`, and MCP `lore_search`
- the same `tools/acceptance/test/cloudflare-smoke.test.ts` file also forces a test-only
  failure immediately after candidate projection, mutates the local sealed build, then
  resumes with `lore deploy cloudflare --resume <receiptId>` and proves the remote search
  surface did not pick up that local mutation, which is the checked-in evidence that resume
  reused the prior projection instead of silently restarting it
- the same `tools/acceptance/test/cloudflare-smoke.test.ts` file also mutates a real local
  build to advertise `semantic-search`, then proves `lore deploy cloudflare` refuses it with
  `LORE_E_CAPABILITY_LOSS` unless the loss is explicitly named

The broader Phase 2 contract-suite and CI artifact cases are still open work on `#93`.

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

Before provisioning a new target, the smoke also reclaims stale D1 catalog databases left by
older CI runs under the same `LORE_CF_TEST_PREFIX`. Manual runs without `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT` do not perform this stale cleanup, because the harness cannot distinguish
old manual resources from resources a person is still inspecting.

CI artifacts for that suite must include:

- deployment receipts
- the local build id and the remote build ids observed during verification
- command logs for setup, deploy, resume, and rollback
- any generated result summary used by the acceptance gate

The checked-in smoke now writes those files under `LORE_CF_ARTIFACT_DIR/<project-name>/`
when the environment variable is present.

Those artifacts are what make a skipped run visibly different from a failing or passing one,
and what let a later session audit the exact remote state transitions that were observed.

## Verified against

Credentialed Cloudflare acceptance smoke in CI as of 2026-08-09, with current local Wrangler
package 4.119.0 confirmed on 2026-08-13.
