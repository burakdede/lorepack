# Cloudflare integration testing

The acceptance lane exercises the real CLI's Cloudflare setup, deployment, authenticated
reads, rollback and cleanup. It uses a dedicated test account and a repository-specific prefix.
Local ownership and cleanup regressions were verified on 2026-10-15 with Node 24.21.0 and
pinned Wrangler 4.149.0. Those tests simulate provider responses; credentialed CI runs the
actual CLI and records the remote results as artifacts.

## Required environment

The checked-in credential gate expects these environment variables:

- `CLOUDFLARE_API_TOKEN`: account-scoped token used by Wrangler and any direct Cloudflare API
  calls in the integration harness
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the dedicated test resources
- `LORE_CF_TEST_PREFIX`: lowercase resource prefix for this repository's integration resources

The required CI job sets `LORE_CF_REQUIRED=1`. Missing, empty or whitespace-only values
for any of the three variables above fail suite collection before a remote operation.
The error names variables, never credential values. Leave required mode unset for an
optional local run that skips the credentialed scenarios explicitly.

Optional CI metadata:

- `GITHUB_RUN_ID`
- `GITHUB_RUN_ATTEMPT`
- `LORE_CF_ARTIFACT_DIR`

The harness chooses a fresh `lpci-<32 hexadecimal characters>` project name. Its 128-bit
random suffix keeps the CLI's deterministic resource slug below the 40-character truncation
boundary. The real `lorepack target add cloudflare` command still provisions the catalog D1,
tables D1 and build-object R2 bucket. Explicit resource flags would select connect-existing
mode and would not exercise provisioning.

Before returning a target for setup, the harness checks that those names and the planned
per-project Worker name are unused. It writes an ownership intent to the account-scoped
`<LORE_CF_TEST_PREFIX>-acceptance-ledger` bucket under
`ownership/v1/<project-name>.json`. The record binds the account, prefix, run ID, attempt
and project name. It contains no API token, runtime token or source content. The ledger bucket
persists between runs; it is never included in resource cleanup.

Worker deployment retains the shared name `<LORE_CF_TEST_PREFIX>-acceptance-runtime`.
The GitHub Actions job uses the `cloudflare-acceptance` concurrency group with `queue: max`
and a 35-minute timeout. This serializes access to the shared Worker. Manual runs using the
same account and prefix must also avoid overlapping a credentialed CI run.

R2 ownership-ledger reads retry HTTP 429 up to four attempts. A valid `Retry-After` value is
honored up to 30 seconds; otherwise waits grow from 500 ms to 2 seconds. Other HTTP errors and
an exhausted 429 remain failures. This behavior was verified with deterministic response stubs
on 2026-10-23 using Wrangler 4.149.0; it does not claim a live Cloudflare acceptance pass.

Provide both `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, or neither for a manual run. For example,
`LORE_CF_TEST_PREFIX=lorepack-ci`, run `12345`, attempt `2` uses the persistent ledger bucket
`lorepack-ci-acceptance-ledger`; its per-project names remain independently random.

When `LORE_CF_ARTIFACT_DIR` is set, the credentialed smoke writes machine-readable command
logs, deployment receipts, and a remote summary into that directory so CI can upload them as
artifacts even when the run later fails during verification or teardown. The ownership intent
is also copied to `ownership-record.json` before CLI provisioning begins. Account-wide D1 list
output is omitted from command artifacts because it includes databases outside the acceptance
project. The test process still receives the full response to select its own database IDs;
account IDs and configured tokens are redacted from stored command output. Worker-script
enumeration uses the API directly and stays in memory. R2 object queries are scoped to the
owned bucket and are not written to command artifacts, so neither adds an account-wide
inventory to the artifact path.

Both suite boundaries write their summary JSON files into `LORE_CF_ARTIFACT_DIR` before
checking required mode. Missing credentials retain `credentialed: false` and the missing
variable names, including when required mode fails. Optional local skips remain visible;
these summaries are not evidence of successful remote qualification.

## Where this environment must exist

The primary release-candidate environment is the `cloudflare acceptance (ubuntu-latest)` job in
`.github/workflows/ci.yml`. A release candidate requires its real credentialed receipts and
remote summaries. Its job-level `LORE_CF_REQUIRED=1` makes missing credentials a failed
check, so an uncredentialed run cannot satisfy the required release check. Forks and
Dependabot runs without the secrets fail this job; no additional secret access is granted.
Optional local shells retain explicit skips. GitHub documents that an
[unset secret becomes an empty string](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

## Token scopes

The token permissions for credentialed acceptance match the setup and
deploy surface already documented for the target receipt flow:

- `Workers Scripts Edit`
- `D1 Edit`
- `Workers R2 Storage Edit`

The lane needs the shared Worker, two D1 databases and a build-object bucket per smoke
project, plus the persistent ownership-ledger bucket. It adds no permission scope beyond
the existing account-scoped token. It does not use Zones, Pages, KV, Queues, Durable Objects,
Vectorize or AI permissions.

## Ownership and cleanup

Cleanup reads the ledger rather than inferring ownership from resource names. It validates
every record's schema, account, prefix and canonical object key before deleting anything.
The cleanup scope must match the current environment. Only older run IDs and earlier
attempts of the same run qualify; current, future and manual records remain untouched.

For each stale intent, cleanup removes its planned Worker, lists every page of bucket objects,
deletes the exact keys through Wrangler, deletes the empty bucket, then removes both the
catalog and tables databases. Missing resources from a partial provisioning attempt are
accepted. D1 deletion retries Cloudflare internal error code 7500 at most twice after the
first attempt. The pinned Wrangler command resolves the owned database name to its UUID and
sends HTTP DELETE; [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)
defines DELETE as idempotent, so retrying the same owned deletion has the same intended
effect. A missing database on retry counts as already deleted. Other D1 errors, malformed
pages and repeated cursors stop cleanup. The ledger entry is deleted only after all resource
deletions succeed, so a failed cleanup can be retried.
Normal teardown also verifies the stored intent against the actual target before deleting
its resources and retiring its record. Each credentialed scenario adds an operational
cleanup probe outside the build's known object keys immediately before teardown. Real
bucket deletion can succeed only after listing and removing that otherwise unreferenced
object. This complements the local multi-page and failed-deletion regressions. Existing operation deadlines and bucket-delete retry
limits are unchanged.

Legacy resources without ledger records are left untouched, even if their names resemble
an older CI run. Review their original CI receipts and remote-summary artifacts before any
manual removal. A new passing run does not prove removal of earlier leaked resources.
Never empty a bucket based only on the historical name pattern.

The local stateful regressions cover crashes before provisioning, after the first D1 database,
and after object uploads; production-shaped names; catalog and tables cleanup; pagination;
wrong-account and malformed records; failed journal writes; and retained records after a
failed deletion. See [ADR 0032](../adr/0032-acceptance-resource-ownership.md).

## Shared corpus and acceptance shape

The remote-versus-local acceptance path must reuse the mixed corpus from
`tools/acceptance/src/mixed-corpus.ts`. This is the same folder the local Milestone 2
scenarios already drive, so any remote comparison is over one corpus rather than over a second
fixture that could drift.

The credentialed suite exercises:

1. `lorepack target add cloudflare`
2. `lorepack target token cloudflare`
3. `lorepack deploy cloudflare`
4. remote REST and MCP reads report the same build id as the deployed local build
5. a second deploy changes the served build id
6. remote rollback returns the earlier build id by pointer change alone

The checked-in smoke now generates a runtime bearer token after `lorepack target add cloudflare`
and passes it through `LORE_REMOTE_BEARER_TOKEN` for deploy and rollback confirmation, and as
`Authorization: Bearer <token>` for direct `GET /v1/build`, `POST /v1/context`, and `POST /mcp`
verification calls.

The same smoke now also proves the rejection side of that contract: an unauthenticated
`GET /v1/build` returns `401`, an unauthenticated MCP `POST /mcp` returns `401`, and a
wrong runtime bearer token is rejected without being echoed back in the response body.

## Visible skip behavior

An optional local run without credentials skips with an explicit message naming the missing
variables. A required run fails with `Cloudflare acceptance requires credentials` and the
same variable names. The actual-command regression removes all three variables in an
isolated child environment and proves both outcomes, including the retained summaries:

```bash
pnpm build
pnpm --filter @lorepack/acceptance exec vitest run test/cloudflare_required.test.ts
```

The missing-credential guard does not establish provider availability or successful deploy,
resume, auth, rollback or cleanup. Those original credentialed scenarios must still pass.
On 2026-10-17 with Node 24.21.0/macOS arm64, the actual-command regression passed in
both modes, along with all 71 applicable local Cloudflare cases and four existing
missing-credential skips. Strict changed-test types and 184 architecture cases passed.
These local checks made no remote requests and do not claim a credentialed result.

The checked-in gates today are:

- `packages/deploy-cloudflare/test/runtime-contract.test.ts`, which now runs the shared
  Phase 2 runtime contract against a real projected Cloudflare fixture backed by the
  package's D1 and R2 ports rather than a hand-wired query fake, including the activation
  invariant
- `tools/acceptance/test/cloudflare-testing.test.ts`, which verifies the environment contract,
  the resource-prefix rule, and the documented skip behavior
- `tools/acceptance/test/cloudflare-smoke.test.ts`, which provisions the shared Worker and isolated D1/R2
  target resources, runs `lorepack target add cloudflare` in automatic provisioning
  mode so the command itself creates both D1 databases and the R2 bucket, rewrites the non-secret
  target receipt to the singleton CI Worker, then deploys the checked-in Worker package, runs
  `lorepack target token cloudflare`, runs
  `lorepack deploy cloudflare`, edits the mixed corpus, runs a second `lorepack deploy cloudflare`,
  proves unauthenticated REST and MCP requests are rejected while the issued runtime token
  succeeds, then verifies the public build id and read surface before and after
  `lorepack rollback --target cloudflare <buildId>` through `GET /v1/build`,
  `POST /v1/context`, and MCP `lore_search`
- the same `tools/acceptance/test/cloudflare-smoke.test.ts` file also forces a test-only
  failure immediately after candidate projection, mutates the local sealed build, then
  resumes with `lorepack deploy cloudflare --resume <receiptId>` and proves the remote search
  surface did not pick up that local mutation, which is the checked-in evidence that resume
  reused the prior projection instead of silently restarting it
- the same `tools/acceptance/test/cloudflare-smoke.test.ts` file also mutates a real local
  build to advertise `semantic-search`, then proves `lorepack deploy cloudflare` refuses it with
  `LORE_E_CAPABILITY_LOSS` unless the loss is explicitly named

## Resource footprint

Each smoke project uses two D1 databases and one build-object R2 bucket. Deployments share
the `<LORE_CF_TEST_PREFIX>-acceptance-runtime` Worker name. The account/prefix also owns one
persistent `<LORE_CF_TEST_PREFIX>-acceptance-ledger` bucket. The corpus stays the same small
mixed acceptance fixture; this lane does not substitute a benchmark workload.

## Teardown and artifacts

Successful teardown removes that project's resources and ownership record. The ledger
bucket persists. If provisioning or teardown fails, its record remains for a later CI run;
manual records are retained until their own teardown or reviewed operator cleanup.
Resources from older protocols without a journal entry are not automatically deleted.

Read-only inspection commands are:

```bash
pnpm --filter @lorepack/deploy-cloudflare exec wrangler d1 list --json
pnpm --filter @lorepack/deploy-cloudflare exec wrangler r2 bucket list
```

Listings and prefixes do not establish ownership. Review the exact intent or original CI
receipts before manually removing legacy resources. Never turn a prefix filter into a
bucket-drain or deletion command.

CI artifacts are written under `LORE_CF_ARTIFACT_DIR` when it is set. Each project directory contains:

- its ownership intent, written before CLI provisioning
- deployment receipts and the local/remote build IDs observed
- command logs for setup, deploy, resume and rollback
- remote summaries and the credential gate's skip/pass/failure summary
- Wrangler debug logs for failed deployments only, with credential sanitization enabled,
  so provider failures can be diagnosed without rerunning the credentialed suite

These artifacts record what the run actually observed. A new passing run does not establish
that an older failed run's resources were removed.

## References

- [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
- [R2 object listing and pagination](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)
- [Raw R2 object reads](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/)
