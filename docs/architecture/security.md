# Security surfaces and where each is verified

Architecture section 20.9 names the classes a release must be tested against. This is the map
from each of them to the test that holds it, so a gap is visible rather than assumed.

The release gate is `pnpm test:security`. It runs the offline privacy-default proof and a
coverage index that names every class below, then CI runs the same command as its own step.
The threat model is in [`threat-model.md`](threat-model.md), and the current pre-release review
is in [`security-review.md`](security-review.md).

Two levels, and the distinction matters. A **unit** test proves a control does what it says. An
**end-to-end** test proves the control is *reached* by a request arriving at the real API over a
real build. A validator nobody calls passes every test it has, so the second is not a
duplication of the first.

## The read-only SQL surface

`packages/cli/test/security.e2e.test.ts`, against the assembled API, plus
`packages/backend-local/test/sql-surface.test.ts` for the tokenizer and authorizer directly,
`packages/core/test/sql-guard.test.ts` for the statement guard rule by rule, and the hostile cases
in the shared runtime contract (`tools/test-support/src/runtime-contract.ts`), which every
backend, local and Cloudflare, must pass.

| Attempt | Refused by |
|---|---|
| `DELETE`, `UPDATE`, `DROP` | The statement shape check: only one SELECT |
| A second statement, including one hidden behind a comment | The same, after comments are stripped |
| `ATTACH` | The same, since it needs a second statement |
| The build catalog, `schema_migrations`, `sqlite_schema`, pragma functions | The statement guard; locally also the per-query authorizer, scoped to one physical table |
| Another table, named any way SQLite accepts (comma join, quoted, bracketed, schema-qualified, as a string literal, after `IN`) | The statement guard's row-source and name rules |
| Learning that another table exists, or its row count (`count(*)`, `EXISTS`, a join that reads no column) | The statement guard. The authorizer alone permits these: it is consulted for column reads, not for opening a table |
| A comment that swallows the result wrapper | The guard removes comments before wrapping |
| `readfile`, `writefile` | They do not exist: `node:sqlite` is built without them |
| A statement above 100,000 characters | The request schema, before anything is parsed |
| A runaway recursive CTE, with or without the `RECURSIVE` keyword | Locally, a five-second deadline enforced by killing the child process; remotely, refused, since D1 cannot be interrupted before its 30 second limit |
| An aggregate used as a window, or a statement whose estimated rows pass 5,000,000 | Remotely only, refused by the guard's cost bound (below) |
| A `printf` or `format` width or precision of `*` or above 100, or a format that is not a string literal | The statement guard, on both backends |
| A CTE named like the table, which would shadow it | The statement guard, on both backends |

### What the remote cost bound does and does not bound

D1 cannot be interrupted before its own 30 second limit, and it runs one query at a time per
database, so one slow table query stalls every other table read on that deployment. Two
controls apply, and neither is complete on its own.

**The guard bounds rows, not cost.** It estimates the rows a statement can form: the table
counts its row count, a VALUES list or a SELECT without FROM the rows it spells out, a subquery
or CTE its own estimate (once per reference), a compound SELECT the sum of its parts, and a
subquery in an expression is charged once per row of the query around it. A statement whose
estimate passes 5,000,000 is refused (#558). It does **not** bound what one row costs. String
functions can grow a value geometrically (nested `replace`, `hex`, `||` through a chain of
CTEs), up to D1's 2 MB value limit, and no static rule over a statement this short can see
that. The guard refuses the one cheap amplifier it can read, a large `printf` width.

**The Worker rate-limits table queries per caller.** Every table query, over REST or MCP,
first passes the `TABLE_QUERY_LIMITER` Workers Rate Limiting binding, keyed on a SHA-256 of
the caller's credential: 20 queries per 60 seconds. Past it the caller gets `LORE_E_BUSY`
(HTTP 429) and D1 never sees the query. A Worker deployed without the binding refuses table
queries (`LORE_E_TARGET_NOT_CONFIGURED`) rather than serving them unbounded. The binding's
counters are per Cloudflare location and eventually consistent, so this bounds sustained
abuse by one token, not the worst single query: one caller can still hold D1 for up to 30
seconds per admitted query. Rotating or revoking the token (`lorepack target token`) is the
response to a token that is being abused.

Coverage: `packages/core/test/sql-guard.test.ts` (estimate and format rules),
`packages/deploy-cloudflare/test/table-query-cost.test.ts` (the guard against the projected
store, and the rate limit on the assembled Worker and its module entry), and the shared
runtime contract (`printf` amplification refused on both backends).

The Cloudflare table adapter applies the same table-query contract before D1 runs the caller's
statement: 100 rows by default, 10,000 rows maximum, and a 1 MB serialized response ceiling.
It wraps the statement in an outer `LIMIT` and asks for one extra row, so truncation is known
without materializing the whole table in the Worker. The local adapter enforces the same shared
constants in its isolated SQLite process. Regression coverage is in
`packages/deploy-cloudflare/test/project-table-data.test.ts` and
`packages/backend-local/test/sql-surface.test.ts`.

The statement guard (`packages/core/src/sql/guard.ts`) is the same code on both backends. On
the Cloudflare Worker it is the isolation control, because D1 has no authorizer and the same
database holds the catalog, every build's tables and the runtime's tokens; it reads the
database's object names afresh for every query. Locally it is a second layer in front of the
authorizer. Every refusal it makes is the same message, so a refusal cannot be used to probe
which names exist, and D1's own error text, which can quote table names, is never returned.

**Each case pins the rule that refused it**, not merely that something did. Written first
without that, the suite passed with the multi-statement tokenizer disabled outright, because
the authorizer caught the second statement too. Defence in depth is why that is comfortable and
exactly why an undifferentiated assertion is useless: the outer layer hides the inner one
failing.

## Reading a source

A read resolves an **artifact identifier against the catalog**. It never joins a caller's string
onto a filesystem path, so a traversal is not a path at all and the whole class is inert by
construction rather than filtered.

Covered end to end for a relative traversal, a percent-encoded one, a POSIX absolute path, a
Windows absolute path, a UNC path, a null-byte suffix, and a path inside `.lore/` itself.

**No response discloses a location on this machine.** Echoing back the identifier the caller
sent is fine and useful; naming where the project lives is not, and that is what is asserted.

## Malformed and hostile documents

Per parser, in `packages/parsers/test/`, because these are properties of the reader rather than
of the boundary:

| Input | Behaviour |
|---|---|
| A ZIP that decompresses far beyond its size | Refused against a running total, so it fails at the threshold rather than after |
| An XML entity expansion (billion laughs) | Refused: a DOCTYPE is rejected outright |
| An external entity naming `file:///etc/passwd` | The same |
| An encrypted PDF | Refused, saying it is encrypted |
| A PDF with no text layer | The build is refused with an OCR remediation; the active build is unchanged |
| A file whose bytes are not readable text | Excluded at fingerprinting, with a warning |
| A table past a column or row limit | Excluded with a warning; the build succeeds (#242) |

## DNS rebinding

The local server refuses any `Host` header that is not a loopback name or an address it was
explicitly bound to, before any route runs, `/mcp` included (#547). That, not the `Origin`
check, is the rebinding defence: a rebound page is same-origin, and a browser sends no
`Origin` on a same-origin `GET`. `tools/security/test/local-server.test.ts` drives the real
`lorepack dev` binary with `Host: attacker.example` against `/v1/sources/:id`,
`/v1/diagnostics`, `/v1/builds`, `/health` and `/mcp`; `packages/runtime/test/http.test.ts`
and `packages/cli/test/serving.test.ts` pin the check and the list.

## The write surface

There is one: `ApiOptions.localActions`, supplied only by `lorepack dev`. A browser caller must
be the page this server served: its `Origin` must match the request's `Host`, port included,
and name a loopback host, so a page on another `localhost` port is refused (#548). Every JSON
route refuses a `text/plain`, form-encoded or untyped body with `415`, which forces a CORS
preflight on any cross-origin page, and the HTTP pack route has no `out` field, so no caller
chooses which file is written. `tools/security/test/local-server.test.ts` replays the
original attack, a `text/plain` POST naming an output path from `http://localhost:8080`,
against the real binary and asserts the target file is untouched. A runtime built without
`localActions` has **no mutating route at all**, which the end-to-end suite asserts by
requesting each one and expecting a typed 404.

`lorepack dev` supplies no `localActions` when bound to a non-loopback address, because the
write guard admits a request with no `Origin` and a network client sends none (#549).
`packages/cli/test/dev.e2e.test.ts` drives `lorepack dev --host 0.0.0.0` and asserts every
write route, `/v1/plan` and `/v1/diagnostics` are 404 while Studio and the build reads still
answer.

That is checked by **registration rather than by HTTP method**, because
`POST /v1/tables/:id/query` is a read: a SQL statement does not belong in a URL. A method-based
check would either exclude the query route or admit a genuine write that happened to be a `GET`.

## Privacy defaults

`tools/security/test/privacy-defaults.test.ts` blocks `fetch` and Node socket connection
attempts inside a real `lorepack build` invocation. The fixture includes an external URL and a
script tag, so the test proves the core build path treats source content as bytes and never
executes or fetches it. There is no telemetry path in the compiler, and the test would fail if
one were added through Node's standard network path.

## Remote runtime authentication

`packages/deploy-cloudflare/test/runtime-auth.test.ts`,
`packages/deploy-cloudflare/test/access-auth.test.ts` and
`packages/deploy-cloudflare/test/worker-app.test.ts` cover the remote projection boundary.
Missing bearer tokens, malformed bearer tokens, deployment credentials, expired rotated tokens
and rejected Cloudflare Access JWTs fail before a build is read. Rejected token material is not
echoed in the Worker 401 response.

## What is not covered here

- **Cross-platform runs of these suites.** `verify` runs on macOS, Windows and Linux in CI, so
  they execute everywhere; what is untested is any platform-specific escape, such as an NTFS
  alternate data stream.
- **Live credentialed Cloudflare drift.** The checked-in remote auth and Worker tests run
  locally without credentials. The credentialed Cloudflare smoke remains the live-account proof.
- **Local authentication.** There is none locally, by design: the server binds loopback and
  serves one project. The `Host` allowlist, same-origin checks and the JSON content-type
  requirement protect it from web pages. A process running as the same user can call it
  freely, which the threat model lists as a non-goal.
