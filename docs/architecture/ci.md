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
existing records and rejects conflicting transforms. Recognized uncovered-report
queries use the physical filename in preparation records for generated JSX debug
metadata. Code returned to the provider remains unchanged; altered code bodies,
source maps and original bytes still fail validation. Type-only erasure accepts an
empty map only when Node's type stripper confirms the original has no executable
code; its empty module marker and map are canonicalized in preparation records.
Dropped executable declarations remain rejected. These records contain no hit
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

Both collectors finalize after synchronous exit listeners return, including listeners
registered later by owned modules. They delegate the original process emitter and use
Node's verified `_exiting` state to ignore manually emitted events for finalization.
Actual manual events still invoke their listeners normally. File and restricted compiled
stream fixtures assert real cleanup hits and one final completion after all increments.
The runtime boundary and upgrade qualification are recorded in
[ADR 0018](../adr/0018-native-exit-finalization.md).

Promises scheduled by exit listeners can still run after synchronous finalization.
Counter streams reject those later events. File capture observes actual source registration
and counter mutations after its snapshot, retains a rejection record and returns unavailable
maps. Load hooks remain active through shutdown so late owned modules cannot escape that
check. The real microtask fixture retains its expected output while rejecting the stale
snapshot. Complete shutdown capture must resolve this boundary before campaign qualification.

Native preloads pass `pathToFileURL(...).href` to Node's `--import`; drive paths are
not valid ESM specifiers on Windows. The native fixtures execute that same form.
`reconcileNativeCapture` validates every lifecycle file, matched process/thread
identity, loaded source hash and map/counter scope. Empty or malformed JSON,
duplicate snapshot files, orphan records, missing completions and rejected loads
cannot qualify capture. It remaps each final snapshot with the pinned engine,
requires exact direct layouts where supplied, and checks compatibility before
merging independent executions once. Failure returns unavailable maps; capture
validity alone does not establish the original all-owned coverage targets.

Compiled-child qualification fixtures instrument canonical preparations before
bundling with esbuild. Instrumenting TypeScript compiler output after compilation
does not reproduce the direct provider's source locations. `compiledCapturePlugin`
uses the original emitted artifact's single-source map to identify its owned input,
then loads the checked canonical instrumented preparation. The ordinary artifact
and map remain untouched. Receipts bind both emitted files, original source bytes
and instrumented code by SHA256; differing mapped sources, stale originals,
altered preparations or changing inputs between loads fail compilation. The plugin
supports the project's standard TypeScript `src` to `dist` layout and rejects
unowned package distribution modules. Measurement bundles require a separate output
directory and keep normal relative imports.

`buildNativeCli` uses the same `bundleCli` function as ordinary builds, emitting
the two CLI entries and all three child entries into a separate fresh directory.
It retains CLI package metadata, Studio assets, dependency resolution and copied
migrations, and publishes source-bound compilation receipts. It refuses the
ordinary CLI output and a nonempty measurement directory. Importing the ordinary
builder no longer invokes a build; its command still uses the production defaults.
The builder and `registerCompiledCapture` share one checked compiled-input reader.
An explicit Node preload captures owned raw compiled imports through the same
instrumentation and descriptor stream, including imports from `--eval`. A real
fixture preserves ordinary output and unused-function zero counts. Automatic
`createEvalCapture` adds a checked preload entry for async and sync Node eval
launches. Its receipt identifies eval-import mode, and the preload removes only
its injected arguments from `process.execArgv` before the original program runs.
Real executions preserve output, argv, environment, cwd and module URL, then
reconcile actual process closes and source counters. Installing this entry in the
complete campaign remains unfinished. The same checked preload supports an
explicit script-import mode for unregistered script files with the original heap
prefix. File launches preserve their module URL and application arguments;
`--eval` after the script path remains an application argument. Async and sync
temporary-script executions reconcile through that explicit launch mode.
Campaign adapters retain audit records for Node launches outside their supported
forms. Records contain argument digests and prefix option names, excluding eval
text and environment values. Unregistered launches execute normally but prevent
native qualification. A private fork handoff marker avoids auditing the same
registered IPC launch twice. Invalid audit records also fail qualification.
It also emits `capture-entry.mjs` and `launch.receipts.json`, binding the bootstrap,
eval/script preloads and their explicit registry modes,
entry wrappers, measured bodies, shared chunks, source maps and initialization module by SHA256. The bootstrap registers measured
parser/query forks and the archive verifier's heap-prefixed command, records their
executions under its `captures` directory, and drains actual closes before exit.
The complete emitted JavaScript graph is checked before execution and campaign registration.
Entry wrappers import one initialization module before their owned body dependencies; shared
chunks carry no collector banner. This initializes counters once before shared code runs.
See [ADR 0021](../adr/0021-shared-chunk-capture.md). Real compiler/builder
fixtures preserve exit7, restricted IPC and heap flags, retain two observed SIGKILL
interruptions and one completed archive execution, and reject altered artifacts.
Installing these generated artifacts in the complete campaign remains necessary.
`sourceCoverageConfig` accepts an optional worker setup file for each selected project.
A real Vitest fixture verifies that the generated setup and inherited project setup
both execute; attaching it does not replace the existing setup.
`writeCampaignSetup` installs the checked registry in a real Vitest worker and
drains actual process closes before restoring bindings at file teardown. The
compiler fixture verifies automatic CLI redirection and all three nested children.
The complete campaign does not yet install this setup.

`registerForkCapture` explicitly maps ordinary child entrypoints to checked measured
artifacts. It verifies both hashes at registration and immediately before launch,
preserves the original four-descriptor IPC layout, and adds only the capture file
descriptor. An explicitly registered measured child may use the same original and
target file, adding the descriptor without changing its entrypoint.
Unregistered launches delegate unchanged.
Shared measured targets retain each ordinary entrypoint's identity; an explicitly
registered measured sibling takes priority over inferred target aliases. Duplicate
ordinary entrypoints and targets that redirect to another target are rejected.
It records actual child and
parent identities, argument hashes, environment mode, requested kill results and
observed close status; environment values and raw arguments are not recorded.
The `settled()` finalizer drains child close receipts after the host returns. It
temporarily keeps the capture parent's event loop alive because the query host
deliberately unrefs its child. Query execution still returns without waiting for
termination. The finalizer must run after registered hosts stop their children.
`runCapturedCli` intercepts a requested CLI exit with a private control exception,
unwinds the normal entrypoint import, drains fork and command close receipts, restores the original
bindings and invokes the original exit with its exact arguments. Unexpected import
errors remain errors. Real fixtures retain exit code 7, skip statements after exit,
preserve permission/IPC limits and reconcile the actual child SIGKILL receipt.
Normal build, HTTP query/SIGTERM and MCP client-close probes pass, but complete
signal/failure qualification and installation into the campaign remain open.
Extra existing descriptors remain unsupported; complete CLI/verification launch
integration and parent-exit qualification remain open.

`createCampaignRegistry` checks the generated CLI launch receipts and binds ordinary
compiled and bundled entrypoints to measured targets. `registerCampaignCapture`
installs fork, asynchronous command and synchronous command capture together,
restores prior bindings if registration fails, and settles real closes before
restoring the adapters. A real compiler/worker fixture reconciles ten independent
executions including nested CLI children, preserving IPC, permissions, heap flags
and exit7. Automatic worker setup and complete campaign integration remain open.

`registerCommandCapture` intercepts the shared asynchronous `ChildProcess.spawn`
method before descriptor normalization. Node's original `spawn`, callback `execFile`
and custom promise wrapper remain intact, including buffering, errors and timeouts.
Only the current Node executable with an explicitly registered script argument
is mapped. Both command adapters accept a registered `nodeArguments` heap-flag prefix,
such as the archive verifier's `--max-old-space-size=128`, without changing the flag
or script arguments. Unregistered prefixes delegate unchanged. Real async and sync
fixtures verify the actual `process.execArgv` and exact three-times-direct counters;
eval prefixes cannot be registered. Multiple ordinary entrypoints may share a measured artifact; the invoked
entrypoint is retained in its receipt. A measured target is registered explicitly
when launched directly. Other commands and unregistered Node eval/flag launches delegate unchanged.
The original three streams are preserved, descriptor 3 is ignored and descriptor 4
receives the parent-opened capture file. Additional existing descriptors reject capture.
Environment mode is recorded as `normalized` because this boundary receives Node's
resolved environment; no values are recorded or changed. Kill receipts retain actual
numeric signals from Node's timeout handling. Reconciliation matches them against
the platform's signal constants and observed close signal.
Real fixtures retain exact callback/promise results, nonzero errors, timeout behavior
and output truncation, with eight independent executions contributing exactly eight
times the direct counts. Complete campaign integration remains open.

`registerSyncCommandCapture` registers both `spawnSync` and `execFileSync` because
Node's latter API calls its internal spawn function. The adapter uses actual native
results and PIDs, retains caller options and original output slots, and preserves
stderr forwarding, stdout returns and nonzero error fields. Separate parent-opened
descriptor 4 avoids waiting for a pipe while the parent is blocked.
Native timeout/buffer stops retain their observed error code and requested signal
separately from JavaScript kill receipts; reconciliation requires the registered signal
and matching native error evidence. Real timeout fixtures remain interrupted and
contribute their actual counters once. Registered shell entrypoints and additional
descriptors remain unsupported. Integration into the complete campaign remains open.

`registerCounterStream` uses a separate inherited descriptor (4 or greater), preserving the existing IPC
descriptor and child permissions. It forwards actual engine source registrations
and cumulative counter mutations with contiguous sequence numbers. Strict replay
rejects truncated frames, sequence gaps, duplicate sources, initial hits, invalid
increments and mismatched completion identities. It never sums cumulative values.
An observed host close can qualify genuine counter frames following the JavaScript
completion event, since natural-exit microtasks can still execute afterward. The
close must match the actual stream PID/thread and normal exit code. Unqualified
continuations and repeated completions still reject. A real compiled regression
retains the late cleanup function hit and matching direct source locations; wrong
PID, wrong code and repeated completion controls fail.
See [ADR 0019](../adr/0019-host-close-counter-stream.md).
`reconcileForkCapture` checks registered original/target hashes, launch/close identity,
actual child PID and all capture files before remapping. A normal exit must match the
counter completion code. An interrupted stream requires an explicitly permitted signal
and a successful matching host kill receipt. Its state remains `interrupted`.
The JavaScript exit event can precede OS termination: a successful host kill during
that window retains `counterState: completed` and its reported code, while the host
lifecycle remains `interrupted` with the actual signal and null exit code. A real
child held inside an exit callback verifies this ordering without synthesizing records.
Missing, truncated, orphaned and repeated execution streams reject qualification.
Every source layout must match direct and previously merged maps; each independent
execution contributes once. Real normal/interrupted child fixtures verify exact merged
counts and exercise invalid receipt, stream, signal and layout controls.

Real fork fixtures use an empty environment, the permission model and the same
heap limit while testing normal exit, SIGKILL and temporarily paused pipe reads.
An actual synchronous child uses a parent-opened file descriptor instead of a pipe:
the parent cannot drain an asynchronous pipe while blocked in `execFileSync`.
The inherited descriptor gives access to the capture file without a filesystem
path permission grant; the child still reports filesystem writes disallowed.
Remapped maps and counters match direct instrumentation exactly. SIGKILL retains
executed counters with state `interrupted` and no invented exit completion. The
host must still prove expected termination before that execution can qualify.
These primitives do not yet replace the production child capture path; large
source registrations and native Windows pipe behavior remain qualification work.

Vitest hard-excludes configuration files, even with an explicit coverage include.
Configuration capture prepares them separately through Vite's public
[transform API](https://vite.dev/guide/api-javascript#transformwithoxc), using the
version resolved by Vitest and original source-map content. It uses the same
pinned instrumenter, including the default-export expression statement correction.
The native child runs the original configuration assertions and strict reconciliation
before the full owned inventory binds the configuration bundle. Default-export
declarations and type-only/barrel scope remain unchanged. Remapped filenames are
canonicalized only after source/duplicate validation so Windows slash spellings
cannot be confused with unowned source identities.
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
inventory, then runs the complete default suite to retain canonical preparations.
It builds separate measured CLI artifacts and adds their checked registry to each
selected Vitest worker. It compares normal and measured file/project collection. Source aliases
match exact package exports. The parsers retain their compiled layout, and configless
projects retain their package identities, including MCP. Generated configuration lives
in the artifact directory; owned configurations stay in the inventory.

The command imports every owned Vite/Vitest configuration with source-hash and semantic
checks. A second complete default-suite run collects direct coverage and streamed
native counters through the generated worker registry. Both passes bound worker
concurrency to two; test selection, assertions and deadlines stay unchanged.
The final report combines direct, configuration and reconciled native records
through the common pinned instrumenter, without a child V8 conversion pass.
It invokes the actual pnpm script entrypoint through Node rather than shell command quoting.
An explicit fixture collector can temporarily layer over the campaign collector.
Its launches retain their own receipts and counter streams; restoring it reinstates the
campaign bindings. A second explicit collector is rejected, and private launch markers
prevent the underlying campaign adapter from wrapping the same launch twice.
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
