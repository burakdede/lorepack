# ADR: how Lorepack edits a TOML client configuration

**Status**: accepted, 2026-08-05. Decided for #80 (the Codex connector), extended to JSON with
comments by #81 (VS Code), and binding on any adapter whose client configuration can carry a
comment.

## The decision

Use **`smol-toml` to parse, and a textual splice to write.** The parser decides whether the
file may be touched at all and what is already in it. The write replaces only the lines of
Lorepack's own table and leaves every other byte exactly as the user typed it.

Ownership is recorded as a **comment** above the table, not as a key inside it.

## Why not the obvious thing

The obvious thing is parse, merge, stringify, which is exactly what the JSON adapters do in
[`json-config.ts`](../../packages/connect-clients/src/json-config.ts). It does not transfer,
for one measured reason.

Three TOML libraries were installed and run against a realistic hand-written
`config.toml` containing comments, unrelated sections and an existing MCP server:

| Library | Version | Licence | Deps | Installed | Last release | Round trip keeps comments |
|---|---|---|---|---|---|---|
| `smol-toml` | 1.7.1 | BSD-3-Clause | 0 | 316 KB | 2026-07-26 | **no** |
| `@iarna/toml` | 2.2.5 | ISC | 0 | 164 KB | 2020-04-23 | **no** |
| `@ltd/j-toml` | 1.38.0 | LGPL-3.0 | 0 | 820 KB | 2023-01-16 | **no** |

**None of them preserves a comment.** A configuration file is not a data file: it is
something a person wrote, and the comment saying "the sandbox settings took a while to get
right, do not change them" is the most valuable line in it. A merge that silently deletes
every such line produces a valid file, passes every test that checks the servers are still
there, and is discovered weeks later. Architecture 24.8 names that class of failure directly.

So the format's own properties force the strategy. A splice is more code than a round trip,
and it is the only option that keeps the promise.

## Why `smol-toml` for the parsing half

The others were rejected on their own merits before the round trip even mattered:

- **`@iarna/toml`**: no release since April 2020, and it implements TOML **0.5**. A parser
  that predates the 1.0 specification will one day refuse a file the client accepts, and
  refusing to edit a valid file is a support burden with no upside.
- **`@ltd/j-toml`**: **LGPL-3.0**, which is not a licence to take into an Apache-2.0 project
  for a convenience. It also failed a plain round trip in the spike, throwing
  `Do not know how to serialize a BigInt` on the ordinary integer `1_000_000`.

`smol-toml` passes on every axis the working agreement §9 asks about: BSD-3-Clause, **zero
dependencies**, 316 KB installed, no install or post-install script, no native code, released
2026-07-26 with 26 releases, and 27.8M weekly downloads. Measured directly rather than read
about: dotted keys, inline tables, literal strings, multi-line strings, underscored integers
and offset datetimes all parse, a malformed table header is refused, and a duplicate table
definition is refused rather than silently merged.

One caveat found by measurement and worked around rather than reported to the user:
**`smol-toml` refuses a leading byte order mark**, which Windows editors write. The mark is
stripped before parsing and restored on write, because telling somebody their configuration
is broken when it is not would be worse than the three lines it costs.

## Why ownership is a comment

The JSON adapters mark ownership with an `x-lorepack` key inside the entry, and Codex 0.146.1
was measured **tolerating exactly that**: an unknown key inside `[mcp_servers.lorepack]` is
ignored and the server still lists. The key is still not what gets written, because the two
failure modes are not comparable in size:

- A marker a future Codex refuses is a `config.toml` that **no longer loads at all**, with
  Lorepack's name on the change that broke it.
- A comment lost to some reformatting tool means `lore disconnect` leaves our table in place,
  and the user deletes five lines by hand.

The first is the failure 24.8 exists to prevent. The second is an inconvenience. Choosing the
marker that cannot cause the first is not a close call, and it costs only that ownership is
read from the raw text rather than from the parsed document, which the splice needs anyway.

## What this constrains

- Every adapter over a TOML file uses
  [`toml-config.ts`](../../packages/connect-clients/src/toml-config.ts), the same way every
  adapter over a JSON file uses `json-config.ts`.
- A table that cannot be located in the text is **not** spliced blindly. If the parsed
  document says the entry exists and the text does not show where, the adapter refuses and
  offers a snippet, because a splice that guesses at a position is how the wrong lines move.
- `mcp_servers` declared as anything other than a table of tables (`mcp_servers = 3`, or an
  array of tables) is refused. Both are valid TOML, and neither is a shape a server table can
  be spliced into.

## The same decision in JSON, for VS Code (#81)

`.vscode/mcp.json` turned out to be the identical problem wearing a different syntax. VS Code's
own schema for the file declares `allowComments: true` and `allowTrailingCommas: true`, so
`JSON.parse` refuses configurations the client accepts, and a parse-and-rewrite would delete
the comments in them.

The difference is that JSON has a standard tool for the minimal edit: `jsonc-parser`, which is
what VS Code itself is built on. Measured: `modify` plus `applyEdits` leaves every comment,
every sibling server and the file's indentation byte-identical, writing the same value twice is
byte-identical, and removing the entry restores the original exactly.

Two findings from that phase are worth keeping:

- **`code --add-mcp` does the destructive thing.** Given a hand-written `mcp.json` with
  comments it deleted every one, reformatted the document, and added `"type": "stdio"` to a
  server the user had configured by hand. Architecture 6.6 step 5 prefers a client's own CLI,
  and this is a case where deferring to it would mean adopting the exact damage this ADR
  exists to prevent. It also writes the **user profile** only, which Lorepack never chooses
  silently.
- **Ownership is a comment here for a sharper reason than in TOML.** The VS Code schema for an
  stdio server is `additionalProperties: false`, so an `x-lorepack` key would put a permanent
  error squiggle in the user's editor, on a file we wrote. In TOML the key was merely a risk;
  here it is a visible defect.

One caveat that is not present in the TOML case: if a neighbouring entry in the same object is
written on a single line, inserting ours expands it onto several. Content and comments are
never lost, only that entry's line breaks. Recorded rather than fixed, because normalizing it
would mean re-implementing the formatter.
