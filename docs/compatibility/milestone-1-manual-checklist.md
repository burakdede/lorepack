# Milestone 1: the one step a machine cannot check

Everything in the two-command flow is automated except one thing: **a client asking a human
whether to trust a server.** That prompt exists precisely because a machine should not be
able to answer it, so this is the checklist a person runs.

Run it on a machine that has never had Lorepack on it. Record the date and the client
version, because "it worked" without those is folklore.

## Before you start

| | |
|---|---|
| Client | Claude Code, version recorded below |
| Node | `node --version`, inside `>=24.19.0 <25` |
| Absent | No Python, no Docker, no compiler toolchain, no API key, no account |

Everything else the automated suite covers: `pnpm acceptance` runs the
`dev/` scenarios, and `pnpm vitest run --project cli dev.e2e` drives the real supervisor.

## The checklist

1. **A folder with documents in it, and nothing else.** No `lore.yaml`.

   ```bash
   npx @lorepack/cli dev ./project-context
   ```

   - [ ] It printed the files it created, and they exist.
   - [ ] It built and activated without asking a single question.
   - [ ] It printed `Studio`, `HTTP`, `MCP HTTP`, `MCP stdio` and a `Connect now` list.
   - [ ] The Studio URL opens and shows the build it just made.

   > This line read "it did **not** print a Studio URL" until Phase 4 shipped one. The
   > amendment on #53 said the phase that adds the assets updates the assertion in the same
   > change, and #64 did that in `dev.e2e.test.ts`; this checklist was missed, and said the
   > opposite of the test for a phase. If a later phase adds a line to that block, this is the
   > second place to change.

2. **Connect the client**, from a second terminal in the same project.

   ```bash
   lorepack connect claude-code --dry-run   # read this first
   lorepack connect claude-code
   ```

   - [ ] The dry run printed the exact file and command, and changed nothing.
   - [ ] The real run named a backup path, and that file exists.
   - [ ] It reported `Verified:` with a protocol version, not `Not working yet`.

3. **The step only you can do.** Open Claude Code in the project.

   - [ ] The client shows Lorepack as an MCP server.
   - [ ] If it asks you to approve or trust the project, it says so, and `lorepack connect`
         warned you it would.

   > Expected: with `--shared`, the entry is in `.mcp.json`, which is checked in, and the
   > client asks each person to approve it the first time. Without `--shared`, the entry is
   > in `.claude.json` (in `$CLAUDE_CONFIG_DIR`, else your home directory) under this
   > project's key, local to your machine, and no prompt should appear.
   >
   > - [ ] `claude mcp list`, run in the project, lists `lorepack`.

4. **Ask it something your documents answer.** Not something a model already knows.

   - [ ] The answer cites a file, a heading and a line range.
   - [ ] Opening that file at that line shows the text it quoted.
   - [ ] The answer does not claim a document is correct or out of date. Lorepack ranks by
         declared hints and never decides which of two documents is right.

5. **Change a document while the agent is connected**, and ask again.

   - [ ] The new answer reflects the edit, with no restart and nothing to click.

6. **Take it back.**

   ```bash
   lorepack disconnect claude-code
   ```

   - [ ] The Lorepack entry is gone.
   - [ ] Every other MCP server you had configured is still there.

## What was actually verified

Fill this in each time. An integration page with no date is a claim, not a record.

| Date | Client version | Platform | Result |
|---|---|---|---|
| 2026-08-03 | Claude Code 2.1.220 | Linux x64 | Steps 1, 2 and 6 verified automatically and by hand. Steps 3, 4 and 5 require a human at the client and are unrecorded. |
| 2026-08-04 | Claude Code 2.1.221 | Linux x64 | Step 1 re-run by hand on a five-document project during the Phase 4 closing pass, including the Studio line this checklist had been asserting the absence of. Step 5 verified by hand: an edit produced a new build within one watch interval and the served build id followed. Steps 3 and 4 still require a human at the client and remain unrecorded. |
| 2026-10-10 | Claude Code 2.1.296 | macOS arm64 | Steps 2 and 6, plus the `claude mcp list` check in step 3, run against a temporary `HOME` and `CLAUDE_CONFIG_DIR` (#575): connect reported `Verified: Answered with 7 tools`, `claude mcp list` in the project showed `lorepack ... ✔ Connected`, and after disconnect it showed `No MCP servers configured.` The 2026-08-03 and 2026-08-04 records predate #575 and wrote a file Claude Code does not read servers from. Steps 4 and 5 still need a human at the client. |

## Confirmation and failure-output checks

Verified 2026-10-10 on macOS arm64 with Lorepack 0.1.0 and Node 24.21.0 (#576, #578).
These checks used a temporary project, a stand-in `code` reporting 1.120.0, and a stand-in
`lorepack` that exits immediately. They verify the CLI experience, without testing a real
client's trust prompts.

| Command or action | Observed result |
|---|---|
| `lorepack connect vscode` with piped stdin | Prints the plan, exits 1 with `LORE_E_INVALID_ARGUMENT`, writes no config, and points to `--yes` and `--dry-run`. |
| `lorepack connect vscode --json` with piped stdin | Exits 1, keeps stdout parseable as a JSON error, and prints the plan on stderr. |
| `lorepack connect vscode --dry-run` | Prints the plan, exits 0, writes no config. |
| `lorepack connect vscode` in a terminal, then answer `n` | Prints `Apply these changes? [y/N]`, reports cancellation, exits 0, writes no config. |
| `lorepack connect vscode --yes --json` with the failing server | Writes `.vscode/mcp.json`, exits 3, returns its receipt and `checks` with `ok: false` and `step: spawn`. |

## If a step fails

```bash
lorepack doctor
```

names what is wrong and what to do about it. Include `lorepack doctor --json` in any bug report.
## Hostile corpus output (#579)

Verified 2026-10-11 on macOS arm64 with Node 24.21.0 and the built CLI containing
the #579 sanitizer. A temporary project used ESC and BEL in a Markdown filename,
and OSC 8, screen-clear, C1 CSI and carriage-return sequences in its content.

1. Run `init` with a credential-shaped hostile filename. Its warning shows visible
   escapes such as `id_rsa\x1b[31m.pem`.
2. Run `build`, `inspect sources` and `search rollback`. Paths and snippets show
   visible escapes; the forged link and screen-clear remain readable text.
3. Inspect a missing path containing ESC. The error message and subject both show
   `\x1b[2J`.

The successful commands exited 0; the missing-path command exited 1.
Captured output contained no raw C0 controls except tab and newline, DEL or C1.
Automated tests additionally cover plan, status, diff, terminal exports, unchanged
JSON values and byte-for-byte redirected exports.

## Storage refusals and packing (#572)

Verified 2026-10-11 with the built CLI 0.1.0 containing #572 on macOS arm64,
Node 24.21.0 and SQLite 3.53.4. Use a temporary project and an empty sibling
directory as the target of its `.lore` link.

| Command or action | Observed result |
|---|---|
| `lorepack build` with `.lore` linked outside the project | Exit 1, `LORE_E_PATH_ESCAPE`, no files written to the target. |
| `lorepack doctor` in that project | Prints `FAIL` for the build directory and names its target; exits 0. |
| `lorepack doctor --ci` in that project | The same failed check, exit 1, no target writes. |
| Remove the link, then `lorepack build` | Exit 0 and an active build. |
| `lorepack pack --out context.lorepack`, then `lorepack pack --verify context.lorepack` | Both exit 0; six members verified for the one-document fixture. |

The real SQLite-full and killed-archive cases run in
`packages/backend-local/test/storage-faults.test.ts` and the mandatory security gate.

### Replacing a private archive (#686)

Verified on 2026-10-11, macOS arm64, Node 24.21.0, with the built CLI:

1. Build a project, then run `lorepack pack --out private.lorepack`.
2. Run `chmod 600 private.lorepack`, then repeat the same pack command.
3. Inspect the file mode: it remains `0600`.
4. Run `lorepack pack --verify private.lorepack`: exit 0, six members intact.

Real filesystem tests also check a changed umask and the temporary file during an
interrupted write. POSIX mode assertions do not apply to Windows; interrupted
replacement and archive verification still run there.
