# Continuous integration

The verification, benchmark, release and commit-hygiene workflows each own a separate gate. The
verification and benchmark workflows both run on pull requests. The release workflow consumes
their results before publishing.

## `ci.yml`

Runs on every pull request and every push to `main`, across a three-way OS matrix
(`ubuntu-latest`, `windows-latest`, `macos-latest`) on Node 24.21.0. `fail-fast` is off so
a Windows-only failure is visible even when Linux is green, which is the whole reason the
matrix exists.

The verification job checks out complete Git history (`fetch-depth: 0`). Its changeset
gate fetches the base and PR head together without a depth limit or pruning, then checks
the explicit PR head. A shallow graph can hide the common ancestor and miss an earlier
release declaration; pruning can remove the base ref during a targeted fetch. Real
70-commit fixtures verify both valid and missing declarations with pruning on and off.
See [checkout's history setting](https://github.com/actions/checkout#usage).

The generated-release fixture imports its original two-commit history with
[Git fast-import](https://git-scm.com/docs/git-fast-import), then checks the real commit
subjects and added/deleted changeset paths before running the unchanged policy subprocess.
This replaces eight fixture Git launches with one import and one history read. Its existing
five-second deadline, data, refs, scheduling, retries and success assertion remain unchanged;
macOS timings do not qualify Windows. The original native Windows timeout is tracked in #762.


Steps, in order:

1. Assert the resolved Node stays inside `>=24.19.0 <25`. A silent drift below the floor
   would bring back a bundled SQLite older than 3.53.2, with the FTS5 CVEs, so it fails
   loudly instead.
2. `pnpm install --frozen-lockfile`
3. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm typecheck:audit`
4. `pnpm coverage:inventory`, then `pnpm test:arch`, the dependency-direction rules
5. `pnpm test`
6. `pnpm check:no-native`, `pnpm check:no-em-dash`

Test results and coverage upload as artifacts on every run, including failures.

Vitest and its coverage provider are pinned together at 4.1.11. The architecture suite
exercises the installed public redirect-mock registration handler against real files and
Vite's serving policy: an opaque URL cannot escape the project, a denied in-root `.env`
cannot load, and a permitted redirect still works. The child reserves stdout for one
JSON reply, with Vite logging disabled. A real logger startup message exercises this
contract; malformed replies still fail instead of being filtered or partially parsed. These checks cover the contributor
toolchain fix for [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
They do not claim that an ordinary local test run exposes the development WebSocket.

The shared verifier also runs `pnpm check:supply-chain`: the production audit must be
clean at Moderate and above, and the full contributor dependency audit must pass at High
and above. Both run against the registry; an audit request failure fails verification.
The dated dependency-health report and CycloneDX SBOM must match the resolved dependencies.

Package builds type-check `src`. `pnpm typecheck:audit` applies the same strict settings to
the audit regression files listed in [`tsconfig.audit_tests.json`](../../tsconfig.audit_tests.json).
Add new audit regression files to that list. Both `pnpm verify` and native CI run the check.

The `privacy sandbox (ubuntu-latest)` job builds the project and runs
`tools/security/test/privacy-defaults.test.ts` inside a fresh network and mount namespace that
counts every packet (`tools/security/test/sandbox/netns.sh`). It is a separate job because it
needs `sudo`, and Linux only because that namespace has no macOS or Windows equivalent. See
[`security.md`](security.md#privacy-defaults).

## `benchmarks.yml`

Runs the shared evidence protocol on `ubuntu-latest`, `windows-latest` and `macos-latest`. Pull
requests use the small profile. Pushes to `main`, the schedule and manual dispatch use the medium
profile by default, with a large profile available only through explicit dispatch. Each runner
executes the Lorepack, direct FTS5 and offline RAG reports over the same commit, corpus and
workload. Raw JSON and a rendered summary are uploaded for 30 and 90 days respectively.

The summary keeps platform rows separate. It rejects missing protocol fields, mismatched commit or
corpus identity, unsupported artifacts and failed rollback evidence. It never averages unlike
machines. Downloaded artifacts can be checked and rendered locally with:

```sh
pnpm check:benchmark-artifacts <downloaded-directory> --summary summary.md
```

Hosted RAG runs are separate, manual-dispatch-only and protected by the `benchmark-hosted`
environment. Provider secrets are unavailable to pull-request and scheduled runs.

## Local coverage

Run `mise exec -- pnpm test:unit --coverage` under the supported Node 24 runtime. Vitest writes
the text summary and JSON report to `coverage/`; the directory is local output and is not
committed. The coverage provider is pinned to the same version as Vitest in the workspace so
this command exercises the configured report path rather than failing during startup.

`pnpm coverage:inventory` writes `coverage/owned_inventory.json` with source hashes,
critical flags and explicit exclusion reasons. Its tracked
[frozen manifest](../../tools/coverage_inventory/frozen_inventory.json) retains the original
345 owned files and 49 critical files. Newly tracked executable sources extend this set,
including configurations, scripts and acceptance drivers. Deleted baseline files, untracked
owned code and non-regular executable files fail the command. The inventory script counts
itself as owned code. Both local verification and native CI run it.

This inventory is an ownership gate, not proof of coverage target attainment. Vitest's
ordinary report omits executable configurations and some subprocess execution. An all-owned
report must represent every inventory path, capture actual configuration and child execution,
and validate source hashes and compatible counter locations before combining maps. Missing
execution remains uncovered; it never removes a file from the denominator.

### Source-bound coverage reports

Capture the inventory before measurement. Its canonical root, commit, dirty-worktree flag
and exact source hashes bind later coverage to the measured files:

```sh
pnpm build
pnpm coverage:inventory
pnpm test:unit --coverage
pnpm coverage:report --capture coverage/owned_inventory.json \
  --map coverage/coverage-final.json --origin direct --out coverage/direct.bundle.json
pnpm coverage:report --input coverage/direct.bundle.json --out coverage/owned_report.json
```

The final command exits 1 for failed targets or missing sources. A direct-only report normally
misses configuration files; missing coverage yields null aggregate metrics, never a smaller
denominator. Separately convert genuine configuration/subprocess execution to Istanbul JSON,
then capture each map with the same pre-measurement inventory and a distinct origin. Repeat
`--input` to combine those bundles. This command binds and reports maps; it does not yet
orchestrate those separate captures or make ordinary Vitest coverage complete.

Each incoming source hash must match the current frozen-preserving inventory. Extra paths,
invalid counter IDs/hits, mismatched branch-arm counts and incompatible complete
statement/function/branch maps fail. Maps are cloned before the standard Istanbul merge so
original evidence stays unchanged. A real Node V8 negative witness in
[`coverage_report.test.ts`](../../tools/arch/test/coverage_report.test.ts) verifies that an
unused function and branch stay uncovered. Both scripts themselves remain owned sources.

Convert actual Node V8 records with the checked native converter:

```sh
pnpm coverage:native --inventory coverage/owned_inventory.json \
  --raw coverage/node-v8 --direct coverage/coverage-final.json \
  --origin native --out coverage/native.bundle.json
```

The raw directory must contain genuine `NODE_V8_COVERAGE` records from the same measured
source tree. The converter currently supports owned `.mjs` scripts and executable
`vite.config.ts`/`vitest.config.ts` files. It records other owned native layouts and
incompatible maps as rejected evidence in the bundle; their hits are never merged.
Bundled TypeScript source-map conversion remains unqualified. Evaluated default-export
calls retain their original expression locations and real V8 ranges. A real Node fixture
verifies that this adapter does not cover an unused function or unexecuted branch.
Changed source hashes fail conversion. The final all-owned report still refuses missing
sources and failed targets. This command does not launch the measurement suite or import
configurations automatically; that orchestration remains incomplete.

Targets are fixed: overall lines/statements/functions at least 95% and branches at least 90%;
critical lines/statements at least 98% and functions/branches at least 95%. Failed targets
remain visible in the JSON report. The report command is not part of `pnpm verify` while the
full capture workflow and audited coverage target attainment remain incomplete. Its contract
tests run in the architecture suite, locally and in native CI.

## `commit-hygiene.yml`

Runs on pull requests only. Rejects AI attribution trailers and footers, and an em dash in
any commit message.

The attribution check matches patterns (`Co-Authored-By:`, `Generated with`, the robot
emoji) rather than the bare product name. `CLAUDE.md` is a legitimately committed file, so
matching the word alone would fail the build for mentioning it.

## Required checks

Branch protection on `main` requires a pull request and a linear history. As the workflows
stabilise, add these as required status checks:

- `verify (ubuntu-latest)`
- `verify (windows-latest)`
- `verify (macos-latest)`
- `no AI attribution`

Configure with:

```bash
gh api -X PUT repos/burakdede/lorepack/branches/main/protection \
  -F 'required_status_checks[strict]=true' \
  -F 'required_status_checks[contexts][]=verify (ubuntu-latest)' \
  -F 'required_status_checks[contexts][]=verify (windows-latest)' \
  -F 'required_status_checks[contexts][]=verify (macos-latest)' \
  -F 'required_pull_request_reviews[required_approving_review_count]=0' \
  -F enforce_admins=false -F restrictions=null -F required_linear_history=true
```

## Timing

The budget is under 10 minutes per job. There is no remote build cache, per architecture
section 8.1: add one only when measured timings demand it.

The credentialed Cloudflare acceptance harness shares one Worker across runs.
After Wrangler deploys it, the harness writes that Worker's actual endpoint into
the target receipt alongside its name. Deploy and resume confirm activation
against the same Worker that serves the acceptance requests. Bounded deployment
retries recognize the legacy subdomain propagation response and the newer Worker
endpoint response10007 only after a matching successful upload. Pre-upload missing
Workers, unrelated endpoints and authentication errors remain failures.

The privacy namespace invokes the already installed Vitest entry point with
Node directly. Running pnpm under sudo would change its environment and trigger
dependency installation inside the offline namespace. Installation and build
finish in the unprivileged setup steps before entering the namespace.

The namespace mounts a fresh sysfs so its packet counters describe its own
interfaces, rather than the runner's inherited network devices. The dummy
interface has no automatic IPv6 address and uses a permanent gateway neighbor,
so interface setup and ARP retries cannot contribute unrelated packets during a
build. Counterexamples must transmit packets, then leave a clean build at zero.

The repository architecture scan opens one TypeScript snapshot for all package
and Studio source files. Package rules still apply separately to every import;
sharing the snapshot avoids starting a compiler process per package.

## D1 projection fixture setup

The file-backed SQLite fixture in `project-table-data.test.ts` is complete before the
projection reads it. Seed its schema, metadata and rows in one transaction so individual
setup inserts do not each pay for a durable filesystem commit. The same rows, values,
column-width refusal, D1 SQL LIMIT assertions and original test deadlines remain enforced.
The measured Windows failure and local write-count evidence are tracked in
[issue #757](https://github.com/burakdede/lorepack/issues/757).

Run the complete fixture suite with:

```bash
pnpm build
pnpm exec vitest run packages/deploy-cloudflare/test/project-table-data.test.ts
```

The 70-commit marker/pruning fixtures retain all four combinations and derive actual fetch
commands and depth from CI. Their import creates the PR ref directly; cloning persists
`fetch.prune` through [git clone --config](https://git-scm.com/docs/git-clone), and the test
checks that stored configuration before using it. This removes three redundant Git launches
per case without reducing history, skipping the real clone/fetch or changing the 5000ms deadline.
