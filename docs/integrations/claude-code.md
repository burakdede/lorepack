# Claude Code

**Verified 2026-08-03 against Claude Code 2.1.220**, connecting to `lore mcp` speaking MCP
**2026-07-28**.

```bash
lore dev ./project-context
lore connect claude-code
```

That is the whole thing. The first command builds and serves; the second configures the
client and then proves the server answers.

## What it writes, and where

| Scope | File | When |
|---|---|---|
| project (default) | `.claude/settings.local.json` | `lore connect claude-code` |
| shared | `.mcp.json` | `--shared`, and the client asks each person to trust it |
| user | `~/.claude.json` | `--scope user`, never implied |

The default is the current project, and **`all` never implies user scope**. A user-scope
entry configures every project on the machine to read one project's documents, which for a
private corpus is worse than merely surprising.

The entry is an executable plus an argument array, never a concatenated string:

```json
{
  "mcpServers": {
    "lorepack": {
      "type": "stdio",
      "command": "lore",
      "args": ["mcp", "--project", "/absolute/path", "--ensure-current"],
      "x-lorepack": { "projectRoot": "/absolute/path", "createdAt": "..." }
    }
  }
}
```

`--ensure-current` means a fresh clone works without a prior `lore build`: the server builds
when there is nothing to serve. That is what a person opening a repository in their editor
actually does.

## Why your configuration is safe

Architecture 24.8 names client-configuration corruption as a real risk, and it is the kind
discovered late: the file also holds servers you configured by hand.

- **Nothing is written until you have seen it.** `--dry-run` prints the plan and touches
  nothing.
- **The file is backed up first**, with a timestamp, beside the original.
- **Edits merge and never replace.** Servers you configured stay exactly where they were.
- **Writes are atomic.** An interrupted run leaves the old file, not half of a new one.
- **A file that will not parse is refused**, not overwritten.
- **`x-lorepack` marks what we created**, so `lore disconnect` removes exactly that. A server
  called `lorepack` that you wrote yourself is left alone.

## Verification is part of connecting

`lore connect` spawns the server exactly as Claude Code will, calls `server/discover` and
`tools/list`, and reports which step failed if one does. A configuration file written
correctly, naming a binary that is not on the path, looks exactly like success until you ask
a question and get nothing:

```
  Not working yet: The server could not be started: spawn lore ENOENT.
  Check that `lore` is on the path.
```

If the client has registered the server but not yet trusted it, that is reported as its own
state rather than as a failure. Approving a project is a step you take, not a bug.

## Removing it

```bash
lore disconnect claude-code
```

Removes the Lorepack entry and leaves every other server, and every unrelated setting, where
they were.

## If your version is not supported

```bash
lore connect --snippet
```

prints the exact JSON to paste and changes nothing. An adapter that guessed at an
unrecognized configuration shape is how a working setup becomes a broken one, so it does not
guess.

## Verified against

Claude Code 2.1.220, MCP protocol 2026-07-28, verified 2026-08-03. Local version smoke saw
Claude Code 2.1.228 on 2026-08-13.
