# Claude Code

**Verified 2026-10-10 against Claude Code 2.1.296**, connecting to `lorepack mcp` speaking MCP
**2026-07-28**.

```bash
lorepack dev ./project-context
lorepack connect claude-code
```

That is the whole thing. The first command builds and serves; the second configures the
client and then proves the server answers.

## What it writes, and where

| Scope | File | Where in it | When |
|---|---|---|---|
| project (default) | `.claude.json` in your Claude Code configuration directory | `projects["/absolute/project"].mcpServers` | `lorepack connect claude-code` |
| shared | `.mcp.json` in the project | `mcpServers` | `--shared`, and the client asks each person to trust it |
| user | `.claude.json` in your Claude Code configuration directory | `mcpServers` | `--scope user`, never implied |

The configuration directory is `$CLAUDE_CONFIG_DIR` when that is set, and your home directory
otherwise, so the file is `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. That is where
Claude Code itself keeps both scopes; `lorepack connect` follows the same variable.

The default is Claude Code's own **local** scope: the entry sits in your private
`.claude.json`, but under this project's key, so it loads only in this project and nothing is
added to the repository. The key is the project's real path, which is what Claude Code
records: a project opened through a symlink, or under macOS's `/tmp`, is keyed by where it
actually is. **`all` never implies user scope**. A user-scope entry configures every project on
the machine to read one project's documents, which for a private corpus is worse than merely
surprising.

The entry is an executable plus an argument array, never a concatenated string:

```json
{
  "projects": {
    "/absolute/path": {
      "mcpServers": {
        "lorepack": {
          "type": "stdio",
          "command": "lorepack",
          "args": ["mcp", "--project", "/absolute/path", "--ensure-current"],
          "x-lorepack": { "projectRoot": "/absolute/path", "createdAt": "..." }
        }
      }
    }
  }
}
```

### Upgrading from a version that wrote `.claude/settings.local.json`

Lorepack versions before #575 wrote the default entry to `.claude/settings.local.json`. Claude
Code reads permissions and approvals from that file, never MCP servers, so that entry was never
loaded. `lorepack connect claude-code` now says it will remove that old entry, removes it (and
an `mcpServers` object it leaves empty) after backing the file up, and keeps every other
setting. `lorepack disconnect claude-code` removes it too. An entry there that Lorepack did not
create is left alone.

`.claude.json` is also Claude Code's own state file, which it rewrites while it runs. Connect
while Claude Code is closed, or restart it afterwards, the same as after `claude mcp add`.

`--ensure-current` means a fresh clone works without a prior `lorepack build`: the server builds
when there is nothing to serve. That is what a person opening a repository in their editor
actually does.

## Why your configuration is safe

Architecture 24.8 names client-configuration corruption as a real risk, and it is the kind
discovered late: the file also holds servers you configured by hand.

- **Nothing is written until you have agreed to it.** `connect` plans every client first,
  prints the plan, and asks `Apply these changes? [y/N]`. Without a terminal, in a script or
  CI job, it prints the plan, writes nothing and exits 1 unless you pass `--yes`. `--dry-run`
  prints the plan and touches nothing.
- **The file is backed up first**, with a timestamp, beside the original.
- **Edits merge and never replace.** Servers you configured stay exactly where they were.
- **Writes are atomic.** An interrupted run leaves the old file, not half of a new one.
- **Permissions are kept.** The rewritten file and its backup keep the original's mode, so a
  0600 file holding tokens stays 0600. A user-scope file Lorepack creates is 0600.
- **Links are never followed out of a project.** If a project configuration file, or any
  directory on the way to it, is a symbolic link, `connect` and `disconnect` refuse with
  `LORE_E_PATH_ESCAPE` and read, back up and write nothing: a repository could otherwise link
  it to your home configuration and have your tokens copied into the project. A user-scope
  file that is a link (a dotfile manager's) is edited at its target, and the link stays.
- **A file that will not parse is refused**, not overwritten.
- **`x-lorepack` marks what we created**, so `lorepack disconnect` removes exactly that. A server
  called `lorepack` that you wrote yourself is left alone.

## Verification is part of connecting

`lorepack connect` spawns the server exactly as Claude Code will, calls `server/discover` and
`tools/list`, and reports which step failed if one does. A configuration file written
correctly, naming a binary that is not on the path, looks exactly like success until you ask
a question and get nothing:

```
  Not working yet: The server could not be started: spawn lorepack ENOENT.
  Check that `lorepack` is on the path.
```

The server is spawned and then stopped on every outcome, including a timeout, so a server stuck
in a long first build is not left holding the project lock after `connect` returns. When it
does not start or does not list its tools, `connect` exits 3, so a script can tell; a trust
step the client still asks for is reported but is not a failure.

It then runs `claude mcp list` from the project directory, which is where a local-scope server
is listed. With `--shared`, a server the client has registered but you have not yet approved
is reported as its own state rather than as a failure: approving a project's `.mcp.json` is a
step you take, not a bug. The local scope has no approval step.

## Removing it

```bash
lorepack disconnect claude-code
```

Removes this project's Lorepack entry and leaves every other server, every other project's
entry, and every unrelated setting where they were.

## If your version is not supported

```bash
lorepack connect --snippet
```

prints the exact JSON to paste and changes nothing. An adapter that guessed at an
unrecognized configuration shape is how a working setup becomes a broken one, so it does not
guess.

## Verified by hand

| Date | Client | What was checked |
|---|---|---|
| 2026-10-10 | Claude Code 2.1.296, macOS arm64 | In a temporary `HOME` and `CLAUDE_CONFIG_DIR`: `claude mcp add --scope local viacli -- echo hi` printed `File modified: $CLAUDE_CONFIG_DIR/.claude.json [project: <path>]` and stored the entry under `projects[<path>].mcpServers`; `--scope user` wrote the top-level `mcpServers` of the same file; run from a symlinked directory, the key was the real path. Then, in a built project whose `.claude/settings.local.json` held an entry from an earlier Lorepack: `lorepack connect claude-code` planned the add under `projects[<project>]` and the removal of the old entry, kept `.claude.json` at mode 0600, and reported `Verified: Answered with 7 tools on protocol 2026-07-28.` `claude mcp list` in the project printed `lorepack: lorepack mcp --project <project> --ensure-current - ✔ Connected`, the `x-lorepack` marker was still present after the client ran, and the old file was left as `{"permissions":{"allow":[]}}`. `lorepack disconnect claude-code` removed the entry, and `claude mcp list` then printed `No MCP servers configured.` Before the fix, the same project gave `Not working yet: ... does not list lorepack yet` and `claude mcp list` printed `No MCP servers configured.` |

## Verified against

Claude Code 2.1.296, MCP protocol 2026-07-28, verified 2026-10-10 (above). Earlier records:
Claude Code 2.1.220 on 2026-08-03 and a local version smoke of 2.1.228 on 2026-08-13, both
against the `.claude/settings.local.json` location that Claude Code does not read servers
from, so they did not prove the client loaded the server.
