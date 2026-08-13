# Generic MCP clients

Use this guide for any MCP client that can launch a stdio server with an executable and argument
array.

Verified on **2026-08-03** against `@modelcontextprotocol/server` 2.0.0 and MCP protocol
**2026-07-28**. This generic page was checked on **2026-08-13** against the current Lorepack
CLI command surface.

## Minimal stdio configuration

Configure the client to run:

```json
{
  "command": "lore",
  "args": ["mcp", "--project", "/absolute/path/to/project", "--ensure-current"]
}
```

Use an argument array. Do not concatenate a shell string. Paths with spaces and Windows drive
letters remain unambiguous only when the client passes argv directly.

## Scope implications

Prefer project or workspace scope when the client supports it. User scope makes one corpus
visible to every project the client opens, which is rarely the safe default for private context.

`--ensure-current` asks `lore mcp` to rebuild when sources changed. Use `--active-only` only
when the client must read a pinned build and must not touch the source tree.

## Protocol behavior

The stdio server is read-only at the model boundary. It exposes tools and resources that read
the active build and returns typed errors for unsupported protocol revisions. It has no tool for
build, deploy, source edits, activation, rollback or shell execution.

Every result carries provenance through `SourceLocator`. A client that drops locators is losing
contract data.

## Troubleshooting

| Symptom | Check |
|---|---|
| The client lists no Lorepack tools | Confirm the project or workspace configuration is trusted by the client. |
| The server fails to start | Run `lore mcp --project /absolute/path --ensure-current` manually from the same shell. |
| The client cannot find `lore` | Use an absolute command path or fix the client's PATH. |
| The server reports stale sources | Use `--ensure-current`, or run `lore build` before connecting. |
| The client rejects the protocol | Check that it supports MCP 2026-07-28 or the handshake-era compatibility path. |

## Verified against

MCP protocol 2026-07-28, `@modelcontextprotocol/server` 2.0.0, verified 2026-08-03. Generic
stdio configuration page checked 2026-08-13.
