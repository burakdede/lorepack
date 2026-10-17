# Cited connection verification

Issue #428 replaces tool-list-only success with an independent expected-build and cited-read
check. The corrected red baseline ran against main `250f4022` on 2026-10-16. All nine cases
failed for false success, a missing identity diagnostic or absent proof. An earlier fixture
incorrectly requested a heading-only document's first body line; its failed receipt is retained,
and the corrected fixture uses the existing bounded whole-source read.

## Automated evidence

Verified locally on macOS with Node 24.21.0, SQLite 3.53.4, MCP client 2.2.0 and protocol 2026-07-28.

- Actual MCP binaries reject another project's build and a missing independently expected build.
- Claude Code, Codex, VS Code and verified snippets receive the same lazy expectation reader.
  Test client configurations live in explicit temporary directories, checked before application.
- A cold `--ensure-current` server builds before the host reads its expected identity.
- Empty sources fail. If an object disappears after the independent read, the actual MCP source
  read fails; a successful build-info call alone cannot fabricate proof.
- Host tests continue a build-pinned inventory beyond 100 empty sources, read after source deletion
  and preserve the native source-read bound and explicit truncation.
- The shipped CLI bundle reports the active build and citation in JSON, with no source text.
  A missing snippet command produces the existing environment-failure exit code.
- Existing protocol revision, timeout and child-cleanup cases retain their original assertions.
  Strict checking also covers the touched adapter fixtures and their actual port return types.

The connection suite passed 319 cases across 13 files. The final shipped-bundle CLI file passed
all 17 cases after its command fixture was changed to use the built public entry point. Native
CI and merge remain required before issue closure. This is server verification, not a claim
that any installed external client's trust prompt was accepted; #578 and #102 retain their
independent Windows lifetime and actual-client requirements.

## Acceptance installation and repair guidance

The initial native acceptance jobs on Linux, macOS and Windows all exposed a missing named
`lorepack` command in the runner's PATH. The runner now creates a private installed-command
entry pointing to the exact selected working or staged binary, without changing the process
environment of the test host. Both original two-command snippet checks additionally require
actual cited-read success. The derived catalogue was regenerated for those stronger checks.
The full local acceptance suite passes 157 cases with four existing missing-credential skips;
all 59 original automated scenarios and their exit-code expectations remain intact.

A real empty-project CLI regression first failed because the expected-reader catch omitted
`LoreError.remediation`. Verification now preserves the existing instruction to add a
supported document, rather than only recommending another build of the same empty inputs.
This regression passes with the complete 319-case connection suite and strict test types.
Final integrated native verification remains required.

## Manual checklist

1. Build a supported document project and run `lorepack connect --snippet --json`. Confirm
   `verification.ok`, the active `proof.buildId` and a real `proof.locator`. Source text must
   not appear in the proof. The server's existing ensure-current startup may build first.
2. Configure a supported client in a controlled test profile. Confirm the displayed proof,
   then handle that client's trust prompt separately. Record its exact version and date.
3. Point a test entry at a different build. Verification must name the expected and actual
   build IDs, fail and suggest checking the configured project path.
4. Try an empty project or a missing command. Expect a nonzero verification outcome with a
   concrete next action. Snippet generation must not silently report a working connection.

Matching canonical inputs can have the same build ID in different absolute directories.
The check proves immutable content and provenance; it does not identify a physical directory.

## Wrapper cleanup regression, 2026-10-17

The original shell-wrapper regression failed with a surviving Node descendant and a
held real project lock on macOS arm64 and native Windows, using Node 24.21.0 and MCP
client 2.2.0. The direct controls cleaned up. Native diagnostic PR #791 was closed
unmerged after its capture; a successful diagnostic job was never a product pass.

The regression keeps its original two-second verification timeout. Its final cleanup
uses a fixture nonce before killing recorded PIDs and checks lock recovery. The new
ownership implementation passes the wrapper case and all original controls locally.
Current-source Windows qualification remains required; this does not establish the
cause of unrelated cancellation, source-churn or runner failures.

## Owned verification processes

The SDK's exact base stdio transport still performs automatic modern discovery and
legacy fallback. Each SDK process is a small bridge to a private authenticated local
IPC host. The host owns the actual executable and arguments, including the disposable
probe that the SDK otherwise hides. It reaps the previous server tree before starting
the fresh session. A protocol channel and a separate stderr channel preserve independent
backpressure and byte delivery. Closing stdin and disposing a bridge are distinct events;
an early stderr EOF from the server must not be mistaken for bridge exit.

Cleanup first prevents new launches. It ends server stdin, waits for normal exit and
then signals only owned POSIX process groups or runs the Windows system `taskkill /PID
/T /F` on the owned root. A disposed bridge requests signal-first cleanup for its probe.
The verifier closes its SDK transports and awaits negotiation afterward. Failure to
confirm cleanup returns a failed connection check, even after a successful cited read;
the CLI retains exit code 3 for a failed check. Protocol deadlines and probe retries
are unchanged. Cleanup adds bounded waits: two seconds per graceful/termination stage,
and at most five seconds for the Windows tree-kill command.

This owns ordinary child trees, including hanging npm-style wrappers. It is not an OS
containment service for deliberately daemonized processes or a forcibly killed verifier.
See [ADR0044](../adr/0044-owned-connect-verification-processes.md).

The focused cases cover real modern CLI processes, both legacy method-not-found and
exit-on-probe fallback, probe/session lock ordering, npm-style wrappers with literal
space/metacharacter paths, absence of helper credentials in server environments,
invalid/incomplete IPC pairs, split headers, opaque protocol bytes and early stderr EOF.
The original read proof and all timeout/exit assertions remain intact. Run:

```bash
pnpm build
pnpm exec vitest run --project connect-clients packages/connect-clients/test/verify.test.ts packages/connect-clients/test/verify_process.test.ts
pnpm exec vitest run --project cli packages/cli/test/connect.e2e.test.ts packages/cli/test/connect.test.ts
pnpm check:packed-cli
```

On Node 24.21.0/macOS arm64, 2026-10-17, all ten focused cases pass. The old binary's
wrapper red and an intermediate ownership-ordering red remain retained. The new installed
check drives npm's generated Lorepack shim and the bundled bridge in temporary client
profiles; it never uses the developer's real configuration. All 365 connector and CLI
connection cases passed across 14 files. The packed check installed 145 packages, proved
the cited build through the actual npm shim and reported zero production vulnerabilities.
The full `pnpm verify` run recorded 3,766 passing runtime tests and four existing skips,
then failed the protocol contract because the new legacy fixture duplicated a revision
literal. The fixture now reads the canonical legacy list; its wire value is unchanged.
All 14 affected contract/ownership cases, strict test types, lint and formatting pass.
Production bytes are unchanged since the full run. All remaining original local gates
passed with unchanged source: 86 security cases and five existing platform skips, dependency
and release policies, schemas, documentation and the executable README demo. Native
Linux/macOS/Windows qualification of this correction remains pending.


## macOS process-group inspection, 2026-10-17

PR #796 at `bad2ed8c` failed its real macOS packed-install connection check with
`EPERM` while inspecting an owned process group. This remains failed native evidence.
A separate Node-only macOS probe held an owned exited child unreaped: group inspection
returned `EPERM` with process state `Z`, then `ESRCH` after its parent reaped it. Apple's
[kernel group-signalling implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
excludes zombie members and can return `EPERM` when no eligible member is found. The
probe establishes that OS condition; the failed CI job did not capture its exact member state.

Cleanup now sends the owned group's termination signal and waits within the existing
two-second stage for confirmed absence. An intervening `EPERM` is unknown, never success.
A persistent permission error still fails verification. The escalation stages, protocol
deadlines and original wrapper workload are unchanged. Two fault-injection cases first
failed and now pass: transient inspection followed by absence, and persistent inspection
failure even after the child exits. They apply to POSIX process groups; Windows uses the
separate tree-kill path covered by the original native wrapper and lock regressions.

On Node 24.21.0/macOS arm64, all 367 connector/CLI cases and the clean installed-artifact
check passed after this correction. The installed tree matched 145 tested production
packages and its production audit was clean. Strict test types, lint/format and documentation
checks passed. The full frozen-source suite and native CI remain separate qualification gates;
these focused and installed checks establish local evidence only.
