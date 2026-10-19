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
3. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`
4. `pnpm test:arch`, the dependency-direction rules
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
Its job sets `LORE_CF_REQUIRED=1`: missing credentials fail before remote operations,
while optional local runs retain explicit skips and truthful summary artifacts. See the
[environment contract](../integrations/cloudflare-testing.md#required-environment).

`actionlint` 1.7.12 rejects the existing `concurrency.queue` key on both baseline and
changed workflows. GitHub documents [queueing multiple pending runs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The control remains intact; this tool limitation is recorded rather than counted as a lint pass.
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

### Keep release-policy setup inside its hook

Every policy case creates a fresh real Git repository inside the original 10-second
`beforeEach` hook. Initialize `main` directly with
[`git init --initial-branch`](https://git-scm.com/docs/git-init), preserve the generated
configuration and append the fixture's fixed local identity using
[Git configuration syntax](https://git-scm.com/docs/git-config#_syntax). Real `git add`
and `git commit` still create the initial tree and commit. This avoids two configuration
processes and a redundant branch rename without changing hooks or inherited settings.

The regression reads the actual HEAD, files, local Git configuration and committed
author identity. The original 28 policy cases, all four 70-commit marker/pruning
combinations, real clones and policy subprocesses, assertions and deadlines remain.
On macOS arm64 with Node 24.21.0 and Git 2.55.0 (2026-10-17), an additive Git event
[trace measurement](../testing/evidence/762_policy_setup.json) over the explicit-head case and four original matrix cases recorded six setup
Git launches per case before this change and three afterward. These counts exclude
case-body work and do not identify which historical Windows command was slow.

Run the policy suite with `pnpm exec vitest run tools/arch/test/release-policy.test.ts`.
Local verification passed 29 policy cases and 185 architecture cases. The native
Windows hook failure and pending exact-head qualification remain tracked in
[issue #762](https://github.com/burakdede/lorepack/issues/762). No hook or test deadline,
workload, scheduling, retry, skip, preload or coverage control was relaxed.

## Manual Windows observer diagnosis

The registered benchmark workflow can run its branch version with
`qualification=windows-observer` and `hosted=false`. That mode runs only the
existing large-result pipe acceptance case on Windows, with its original
fixture, configuration and deadlines. It enables the bounded observer trace
described in [Windows diagnostics](../testing/windows_observer_diagnostics.md).
Normal benchmark triggers, profiles and concurrency groups stay unchanged.

```sh
gh workflow run benchmarks.yml --ref <reviewed-diagnostic-branch> \
  -f qualification=windows-observer -f hosted=false -f profile=medium
```

The job retains the exact checkout/runtime identity, raw output, native exit
codes and partial JSON report even after failure. An isolated diagnostic pass
does not establish the full acceptance suite or explain an earlier failure.
