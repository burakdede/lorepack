# VS Code

**Verified 2026-08-05 against VS Code 1.132.0** (commit `df53daab`), connecting to `lore mcp`
speaking MCP **2026-07-28**.

```bash
lore dev ./project-context
lore connect vscode
```

The first command builds and serves; the second configures the workspace and then proves the
server answers.

## What it writes, and where

| Scope | File | When |
|---|---|---|
| workspace (default) | `<project>/.vscode/mcp.json` | `lore connect vscode` |
| user | `~/.config/Code/User/mcp.json`, and the platform equivalent | `--scope user`, never implied |

The default is the workspace, and **`connect all` never writes the user profile**. A profile
entry configures every window on the machine to read one project's documents, which for a
private corpus is worse than merely surprising.

**`.vscode/mcp.json` is shareable, source-controlled configuration.** People commit it
deliberately, and the plan says so before writing, so committing it is a choice you make
knowingly rather than one you discover in a diff.

```jsonc
{
	"servers": {
		// Managed by Lorepack. `lore disconnect vscode` removes exactly this entry.
		// x-lorepack {"projectRoot":"/absolute/path","createdAt":"..."}
		"lorepack": {
			"type": "stdio",
			"command": "lore",
			"args": ["mcp", "--project", "/absolute/path", "--ensure-current"]
		}
	}
}
```

The top-level key is **`servers`**, not the Claude-style `mcpServers`. The wrong key produces
a file VS Code ignores without a word, which looks exactly like a connect that worked.

`--ensure-current` means a fresh clone works without a prior `lore build`.

### `sandboxEnabled` is deliberately not set

VS Code's schema gives `sandboxEnabled` `default: false`, so leaving it out is exactly the
unsandboxed behaviour. Turning it on is not claimed as supported, because it cannot be verified
without driving the real sandbox from inside the editor, and `--ensure-current` writes `.lore/`
on first run, which is precisely what a filesystem sandbox would stop. Shipping it on an
untested guess would turn a working connect into a server that starts and then fails.

## Why the official CLI is not used for the write

Architecture §6.6 step 5 prefers a client's own CLI when it can express the chosen scope
safely. Measured against 1.132.0, `code --add-mcp` cannot, twice over:

- Its own help says it *"Adds a Model Context Protocol server definition to the **user**
  profile"*. There is no workspace option, and it resolves the profile from the real home even
  when `$HOME` points elsewhere.
- Given a hand-written `mcp.json` with comments, it **deleted every comment**, reformatted the
  whole document, and added `"type": "stdio"` to a server that was configured by hand.

Writing the file ourselves is only worth doing because it does better than that. `code
--version` is the only invocation this adapter makes.

## Why your configuration is safe

`.vscode/mcp.json` is JSON with comments: VS Code's own schema for it declares
`allowComments: true` and `allowTrailingCommas: true`, so `// the args took ages to get right`
is a legal line and `JSON.parse` would refuse the whole file over it.

- **Edits are minimal.** Only the Lorepack entry changes. Comments, unrelated servers, other
  settings, your indentation and your line endings survive as they were.
- **Nothing is written until you have seen it.** `--dry-run` prints the plan and touches
  nothing.
- **The file is backed up first**, with a timestamp, beside the original.
- **Writes are atomic.** An interrupted run leaves the old file, not half of a new one.
- **A file that will not parse is refused**, not overwritten. So is one whose `servers` is not
  an object.
- **The ownership comment marks what we created**, so `lore disconnect` removes exactly that.
  A server called `lorepack` that you wrote yourself is left alone. It is a comment rather
  than a key because VS Code's schema for a server is `additionalProperties: false`, so an
  extra key would put a permanent error squiggle in a file we wrote.

One honest caveat: if a neighbouring server in the same object is written on a single line,
adding ours expands it onto several. Content and comments are never lost, only that entry's
line breaks.

## Verification, and the trust dialog

`lore connect` spawns the server exactly as VS Code will, calls `server/discover` and
`tools/list`, and reports which step failed if one does.

VS Code then asks you to confirm you trust the server the first time it starts, and chat runs
without these tools until you do. That is a step you take, not a bug, so it is printed rather
than left to surprise you. VS Code cannot be asked from outside the editor what it has loaded,
so the connect output names the step instead of guessing:

```
  Verified: Answered with 7 tools on protocol 2026-07-28. VS Code will ask you to confirm you
  trust this server the first time it starts; run `MCP: List Servers` from the Command Palette
  to see it.
```

`MCP: List Servers`, `MCP: Add Server` and `MCP: Open User Configuration` in the Command
Palette are the client-side equivalents.

## Verified by hand

Trust dialogs cannot be automated, so the flow was driven against the real binary. This is the
record (working agreement §7).

| Date | Client | What was driven, and what it proved |
|---|---|---|
| 2026-08-05 | VS Code 1.132.0 | A workspace with a hand-written `.vscode/mcp.json` holding two comments and another MCP server. `lore connect vscode` backed the file up, added the entry, and **kept both comments and left the other server without the `"type"` key `code --add-mcp` injects**. It reported `Verified: Answered with 7 tools on protocol 2026-07-28` plus the trust step. Re-running said `Update` and left exactly one entry and one ownership comment. VS Code's own CLI then read the file we wrote and extended it, returning `['lorepack', 'notes', 'probe']` with our entry intact. `lore disconnect vscode` left the file **byte for byte identical to the original**. |

## Removing it

```bash
lore disconnect vscode
```

Removes the Lorepack entry and leaves every other server, comment and setting where they were.

## If your version is not supported

```bash
lore connect vscode --snippet
```

prints the exact JSON to paste and changes nothing.
