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
Direct coverage uses the patched Istanbul provider. A real executed fixture checks used,
unused and async private methods, both async branch arms, and real type-only/barrel records.
The patch applies through pnpm's lockfile, including frozen installs with scripts ignored.
It also exposes the same instrumenter and source-map remapper for native-capture
qualification. A real Node subprocess checks initializer execution once across two
function calls, unused private methods and unexecuted statements after a throw.
This fixture verifies the primitives, not complete configuration or child capture.
The campaign's custom instrumenter retains its actual first transform input in
`preparations/`. Each record binds transformed code and its original source map to
the inventory SHA. Source content must match before collection, including during
Vitest's synthetic second mapping pass. Exclusive atomic publication preserves
existing records and rejects conflicting transforms. These records contain no hit
counters; a real typed/private fixture replays them and requires exact equality
for statement, function and branch maps and counts after remapping.

`scripts/coverage_instrumented.mjs` prepares native instrumentation with the same
pinned engine outside the measured child. Its explicit synchronous Node load hook
replays source-bound code without importing the provider inside restricted processes.
The child validates original loaded bytes, preparation identity and instrumented-code
hashes. It changes no permission flags or environment variables. Unsupported owned
formats and query variants fail with retained rejection details.

Each process/thread registration publishes an exclusive atomic start record and one
completion record containing its final cumulative counters. Empty execution has an
explicit empty map. Duplicate registration fails; repeated cumulative snapshots are
not independent execution. Explicit exit and uncaught failure retain their exit codes.
Forced termination leaves a start record without a fabricated completion. Real fixtures
verify these cases, exact typed/private map replay and file-access denial under identical
permissions. Missing completion still needs campaign reconciliation; compiled children
and complete campaign qualification remain open.
See [ADR 0017](../adr/0017-instrumented-coverage.md). V8 conversion remains separately pinned
for native execution; incompatible layouts still fail and cannot be merged into direct maps.

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
`--input` to combine those bundles. This command binds and reports maps; the campaign
command below orchestrates the captures. Ordinary Vitest coverage alone stays incomplete.

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
configurations automatically; use the campaign command for orchestration.

Resolved tooling modules are dynamically imported through file URLs, including Windows
drive-letter paths. Coverage tools use Node's `import.meta.main` to distinguish commands
from imports. The supported Node range includes this capability. An actual stdin-import
regression checks that importing the native converter (and its report/inventory dependencies)
does not invoke commands or attempt to resolve stdin as a file. Native Windows CI exercises
the real conversion and reporting suites; a macOS pass alone does not qualify portability.

Native conversion reads and processes one raw V8 JSON file at a time. It rejects records
whose full-script range differs from the expected source layout. For configuration
TypeScript, Node's `stripTypeScriptTypes` API removes annotations before parsing while
preserving the original positions, and calculates appended source-URL metadata for the
range check. See the [Node module API](https://nodejs.org/docs/latest-v24.x/api/module.html#modulestriptypescripttypescode-options).
A real wrapped-execution fixture previously received original-source counters; it now remains rejected.
This layout check does not authenticate arbitrary external coverage files. The complete
campaign must generate its own records from the unchanged measured candidate.
It does not retain the complete raw campaign in an array. Converted maps and parsed owned sources remain
available for compatibility checks. The real-record stream test must produce the same counters as the array input,
including uncovered functions. This states the loading strategy, not a peak-memory bound.

Native and direct providers may assign different counter IDs to identical source locations.
Alignment requires a unique one-to-one match of every descriptor in coverage JSON: statement
ranges, function name/declaration/body, and branch type/ranges/ordered arms. Optional function
or branch `line` metadata is redundant only when it equals `loc.start.line`. Coverage JSON
serialization preserves the providers' wire representation, including null end columns.
Alignment rekeys genuine counts without changing them or reducing scope. Ambiguous matches,
nonredundant metadata and reordered branch arms remain rejected. A real installed-provider
fixture checks exercised and unused functions, statements and both branch arms against an
independent native execution.

V8 cannot recover default-parameter branch execution reliably. A real witness executes a
function twice but its initializer once; direct instrumentation records one initializer hit,
while native mapping assigns the function's two calls. Native conversion rejects sources
containing these branches rather than inventing counts. See the
[mapper limitations](https://github.com/AriPerkkio/ast-v8-to-istanbul#limitations).
Those owned sources still require direct instrumentation and remain in the denominator.

Targets are fixed: overall lines/statements/functions at least 95% and branches at least 90%;
critical lines/statements at least 98% and functions/branches at least 95%. Failed targets
remain visible in the JSON report. The report command is not part of `pnpm verify` while the
full capture workflow and audited coverage target attainment remain incomplete. Its contract
tests run in the architecture suite, locally and in native CI.

### Reproducible default-suite campaigns

```sh
pnpm coverage:capture --out coverage/campaign-<fresh-name>
```

The directory must not exist. The command builds first, records the complete source
inventory, then compares normal and source-layout file/project collection. Source aliases
match exact package exports. The parsers retain their compiled layout, and configless
projects retain their package identities, including MCP. Generated configuration lives
in the artifact directory; owned configurations stay in the inventory.

The command imports every owned Vite/Vitest configuration with source-hash and semantic
checks. It runs the complete default suite with direct coverage and actual Node subprocess
capture, converts compatible native maps, then writes the combined source-bound report.
It invokes the actual pnpm script entrypoint through Node rather than shell command quoting.
Failed children stop the campaign. Failed thresholds exit unsuccessfully with the report
retained. Raw records, configuration assertions, collection parity, inventory, direct maps
and accepted/rejected native evidence stay in the directory.

The final report retains rejected native executions with their bundle origin, source and
reason. Any rejection fails qualification and leaves aggregate metrics unavailable, even
when another valid execution represents that source. Missing and rejected sources never
reduce the owned denominator. Invalid native evidence or unowned rejection paths fail parsing.

This measures the default suite. Separate security, acceptance, Studio and release gates
remain required. Missing owned execution stays uncovered; it does not shrink the inventory.
Do not overlap full campaigns or full worktree verifiers. The capture command has contract
tests but does not yet establish final all-owned target attainment or native qualification
of a complete campaign. Keep the release gate open until the measured evidence proves both.

The first complete campaign on Node 24.21.0 with Vitest 4.1.10 passed its 217 test files
and collection check, but the pinned V8 mapper emitted a negative implicit-else counter
in `packages/cli/src/commands/export.ts`. Source-bound capture rejects that map before
aggregation. Retain the raw artifacts and resolve the measurement error; clamping the
counter does not prove either branch ran. Switching providers also requires preserving
every executable counter: the unpatched Istanbul provider omitted private-method function
counters, including lock acquisition and reclamation, and remapping dropped genuinely empty
source records. The pinned dependency patch corrects those omissions. A static comparison
retains all 354 directly measured sources, loses no function line ranges and reduces no
per-file statement/function/branch counts. The 17 configuration files require separate capture.
All 26 export/receipt tests pass with nonnegative counters, including the formerly invalid
branch. This focused evidence does not establish complete native measurement or release
target attainment. Neither the old invalid V8 campaign nor static zero-hit maps qualify release.

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
