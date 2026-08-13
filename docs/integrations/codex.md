# Codex

**Verified 2026-08-05 against `codex-cli` 0.146.1** (`@openai/codex`), connecting to
`lore mcp` speaking MCP **2026-07-28**.

```bash
lore dev ./project-context
lore connect codex
```

The first command builds and serves; the second configures the client and then proves the
server answers.

## Trust the project, or nothing happens

Codex reads a project's `.codex/config.toml` **only in a project you have trusted.** In an
untrusted project it does not warn, does not error, and does not log: `codex mcp list` simply
answers with an empty list, and your agent has never heard of your documents.

So `lore connect codex` says this before it writes anything, and reports it as its own
verification outcome afterwards:

```
  Not working yet: The server answers, but Codex only reads
  /home/me/project/.codex/config.toml in a project you have trusted, and this one is not
  trusted yet. Run `codex` here once and choose to trust the folder.
```

That is not a failure. The file is correct and one interactive step remains. Trust is
recorded in your Codex home configuration:

```toml
[projects."/home/me/project"]
trust_level = "trusted"
```

## What it writes, and where

| Scope | File | When |
|---|---|---|
| project (default) | `<project>/.codex/config.toml` | `lore connect codex` |
| user | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `--scope user`, never implied |

`project` is the scope architecture §6.6 calls *workspace*, under the name the rest of the
CLI already uses. There is deliberately not a third word for it.

**The project file is one people commit.** That is a legitimate thing to do, and the plan
says so before writing, so the choice is yours to make knowingly: anyone who checks out the
repository gets this server entry.

```toml
# Managed by Lorepack. `lore disconnect codex` removes exactly this block.
# x-lorepack {"projectRoot":"/absolute/path","createdAt":"..."}
[mcp_servers.lorepack]
command = "lore"
args = ["mcp", "--project", "/absolute/path", "--ensure-current"]
cwd = "/absolute/path"
```

An executable plus an argument array, never a concatenated shell string, which is what keeps
a project path containing a space correct on Windows. `--ensure-current` means a fresh clone
works without a prior `lore build`.

Our tools are read-only, so no Codex write-approval setting has to change for this to work.

## Why the official CLI is not used for the write

Architecture §6.6 step 5 prefers a client's own CLI when it can express the chosen scope
safely. Measured against 0.146.1, `codex mcp add` cannot:

- it has **no scope flag**, writes `$CODEX_HOME/config.toml`, and reports
  `Added global MCP server 'lorepack'`. Lorepack defaults to the project;
- it offers no way to attach the ownership marker that lets `lore disconnect` remove exactly
  our entry and nothing else.

It is used where it is authoritative and harmless: `codex --version` for detection, and
`codex mcp list --json`, run **from the project directory**, for verification.

## Why your configuration is safe

`config.toml` is a file you wrote by hand, and unlike JSON it carries comments that are often
the most valuable lines in it. **No JavaScript TOML library preserves a comment across a
parse-and-rewrite**, which was measured for three of them, so Lorepack does not do that:

- **It parses to understand, and splices to write.** Only the lines of the Lorepack table
  change. Every comment, every section, every blank line and your file's line endings survive
  exactly as they were.
- **Nothing is written until you have seen it.** `--dry-run` prints the plan and touches
  nothing.
- **The file is backed up first**, with a timestamp, beside the original.
- **Writes are atomic.** An interrupted run leaves the old file, not half of a new one.
- **A file that will not parse is refused**, not overwritten. So is one whose `mcp_servers` is
  not a table of servers, and one that declares `mcp_servers.lorepack` through a dotted key
  with no table header, because appending to that would make the whole file stop parsing.
- **The ownership comment marks what we created**, so `lore disconnect` removes exactly that.
  A server called `lorepack` that you wrote yourself is left alone.

The reasoning, the measurements and the rejected alternatives are in
[`../architecture/adr-toml-merge.md`](../architecture/adr-toml-merge.md).

## Removing it

```bash
lore disconnect codex
```

Removes the Lorepack block and leaves every other server, comment and setting where they
were. On a file Lorepack wrote into, connect followed by disconnect returns it byte for byte.

## Verified by hand

Client trust prompts cannot be automated, so the whole flow was driven by hand against the
real binary. This is the record (working agreement §7).

| Date | Client | What was driven, and what it proved |
|---|---|---|
| 2026-08-05 | `codex-cli` 0.146.1 | A project with a hand-written `config.toml` holding a comment, a sandbox section and one other MCP server. `--dry-run` printed the plan and the trust requirement and wrote nothing. `lore connect codex` backed the file up, added the block, kept every other line, and reported the untrusted project as its own outcome rather than as success. After trusting the project, `codex mcp list --json` returned `['lorepack', 'notes']` and `lore connect codex` reported `Verified: Answered with 7 tools on protocol 2026-07-28`, plus `Update the existing Lorepack server` with still exactly one entry. `lore disconnect codex` left the file **byte for byte identical to the pre-connect backup**, and `codex mcp list` then returned `['notes']`. |

## If your version is not supported

```bash
lore connect codex --snippet
```

prints the exact TOML to paste and changes nothing.

## Verified against

`codex-cli` 0.146.1, MCP protocol 2026-07-28, verified 2026-08-05. Local version smoke saw
`codex-cli` 0.147.0 on 2026-08-13.
