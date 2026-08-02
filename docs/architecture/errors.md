# Error taxonomy

Every failure Lorepack reports is a `LoreError` with a stable code, an exit code, and,
wherever possible, one concrete next step. A bare `Error` gives a user a stack trace and
nothing to do about it, so the architecture rules forbid it in `core`, `compiler`,
`runtime` and `cli` (`pnpm test:arch`).

## Anatomy

```ts
throw new LoreError('LORE_E_PATH_ESCAPE', 'archive/../../etc/passwd escapes the source root.', {
  remediation: 'Move the file inside ./project-context, or remove the symlink.',
  path: 'archive/../../etc/passwd',
  subject: 'source:project-context',
});
```

| Field | Purpose |
|---|---|
| `code` | Stable identifier. Scripts branch on it, docs link to it. Renaming one is a breaking change |
| `message` | What went wrong, in the user's terms |
| `remediation` | One concrete action. Omitted only when genuinely unknowable |
| `path` | Project-relative path, never absolute |
| `subject` | Artifact, build, or table identifier |
| `details` | Structured detail for machines, shown only with `--verbose` |
| `cause` | The underlying error, rendered as a chain |

## Exit codes

| Exit | Meaning | Example codes |
|---:|---|---|
| 1 | User or configuration error | `LORE_E_CONFIG_INVALID`, `LORE_E_PATH_ESCAPE`, `LORE_E_SQL_REJECTED`, `LORE_E_CANCELLED` |
| 2 | Build integrity failure | `LORE_E_PARSE_FAILED`, `LORE_E_BUILD_VALIDATION`, `LORE_E_STALE_SOURCES` |
| 3 | Environment or capability | `LORE_E_UNSUPPORTED_NODE`, `LORE_E_FTS5_UNAVAILABLE` |
| 4 | Concurrency | `LORE_E_LOCK_HELD` |
| 5 | Remote or deployment | `LORE_E_REMOTE_DEPLOY`, `LORE_E_CAPABILITY_LOSS` |

CI can therefore distinguish "your project is wrong" from "this machine is wrong" without
parsing text.

## Classification is part of the contract

A code says who has a problem, and the exit code is derived from it, so misclassifying is
not cosmetic: it tells CI the wrong thing and it tells a person to do the wrong thing.

`LORE_E_INTERNAL` means a defect in Lorepack, and its exit code and remediation both invite
a bug report. An ordinary condition of a real filesystem is not that. A source file that
cannot be opened is `LORE_E_SOURCE_UNREADABLE`, exit 1, naming the display path and pointing
at permissions or `.loreignore`. It used to arrive as `LORE_E_INTERNAL` carrying a raw
`EACCES` and an absolute path (#168).

The `next:` line names only what the binary can do today. Until `lore doctor` ships in
Phase 3, no message refers to it: `scripts/check-command-set.mjs` reads the real `--help`
output and fails when a source string names a command that is not registered. A remediation
that points at a missing command is worse than no remediation, and a unit test had been
asserting the wrong one, so review alone was demonstrably not enough.

## Renderers

One error, three audiences:

- `renderForCli` prints the summary, path, cause chain, and a closing `next:` line. With
  `--verbose` it adds `details`.
- `renderAsJson` produces the stable shape used by `--json` flags and the REST API.
- `renderForProtocol` is model-facing. It strips absolute paths so an MCP client never
  learns the filesystem layout outside the project.

## Redaction

Redaction happens in the renderer, not at each call site, so a message that accidentally
embeds a token cannot leak it however it was built. Three layers:

1. Values of environment variables whose names look secret (`*TOKEN*`, `*SECRET*`,
   `*PASSWORD*`, `*KEY*`, `*CREDENTIAL*`, `*AUTH*`) and are at least 8 characters.
2. Token shapes: `Bearer <token>`, provider-prefixed keys (`sk_`, `ghp_`, `xoxb-`).
3. `NAME=value` and `NAME: value` pairs whose name looks secret.

`redactDeep` applies the same rules through nested objects and arrays, which is what
protects `details` payloads.

## Adding a code

1. Add it to `ERROR_CODES` with a one-line description.
2. Map it in `EXIT_BY_CODE`. The type system requires this, so it cannot be forgotten.
3. Document it here if the remediation needs more than a sentence.
4. Add a changeset: codes are part of the public contract.
