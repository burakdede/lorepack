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
| Node | `node --version`, inside `>=24.15 <25` |
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
   - [ ] It printed `HTTP`, `MCP HTTP`, `MCP stdio` and a `Connect now` list.
   - [ ] It did **not** print a Studio URL. Studio is Phase 4, and printing it would be the
         CLI naming something that does not exist.

2. **Connect the client**, from a second terminal in the same project.

   ```bash
   lore connect claude-code --dry-run   # read this first
   lore connect claude-code
   ```

   - [ ] The dry run printed the exact file and command, and changed nothing.
   - [ ] The real run named a backup path, and that file exists.
   - [ ] It reported `Verified:` with a protocol version, not `Not working yet`.

3. **The step only you can do.** Open Claude Code in the project.

   - [ ] The client shows Lorepack as an MCP server.
   - [ ] If it asks you to approve or trust the project, it says so, and `lore connect`
         warned you it would.

   > Expected: with `--shared`, the entry is in `.mcp.json`, which is checked in, and the
   > client asks each person to approve it the first time. Without `--shared`, the entry is
   > local to your machine and no prompt should appear.

4. **Ask it something your documents answer.** Not something a model already knows.

   - [ ] The answer cites a file, a heading and a line range.
   - [ ] Opening that file at that line shows the text it quoted.
   - [ ] The answer does not claim a document is correct or out of date. Lorepack ranks by
         declared hints and never decides which of two documents is right.

5. **Change a document while the agent is connected**, and ask again.

   - [ ] The new answer reflects the edit, with no restart and nothing to click.

6. **Take it back.**

   ```bash
   lore disconnect claude-code
   ```

   - [ ] The Lorepack entry is gone.
   - [ ] Every other MCP server you had configured is still there.

## What was actually verified

Fill this in each time. An integration page with no date is a claim, not a record.

| Date | Client version | Platform | Result |
|---|---|---|---|
| 2026-08-03 | Claude Code 2.1.220 | Linux x64 | Steps 1, 2 and 6 verified automatically and by hand. Steps 3, 4 and 5 require a human at the client and are unrecorded. |

## If a step fails

```bash
lore doctor
```

names what is wrong and what to do about it. Include `lore doctor --json` in any bug report.
