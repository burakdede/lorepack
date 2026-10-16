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

The connection suite passed 318 cases across 13 files. The final shipped-bundle CLI file passed
all 16 cases after its command fixture was changed to use the built public entry point. Native
CI and merge remain required before issue closure. This is server verification, not a claim
that any installed external client's trust prompt was accepted; #578 and #102 retain their
independent Windows lifetime and actual-client requirements.

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
