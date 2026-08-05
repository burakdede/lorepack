# Security surfaces and where each is verified

Architecture section 20.9 names the classes a release must be tested against. This is the map
from each of them to the test that holds it, so a gap is visible rather than assumed.

Two levels, and the distinction matters. A **unit** test proves a control does what it says. An
**end-to-end** test proves the control is *reached* by a request arriving at the real API over a
real build. A validator nobody calls passes every test it has, so the second is not a
duplication of the first.

## The read-only SQL surface

`packages/cli/test/security.e2e.test.ts`, against the assembled API, plus
`packages/backend-local/test/sql-surface.test.ts` for the tokenizer and authorizer directly.

| Attempt | Refused by |
|---|---|
| `DELETE`, `UPDATE`, `DROP` | The statement shape check: only one SELECT |
| A second statement, including one hidden behind a comment | The same, after comments are stripped |
| `ATTACH` | The same, since it needs a second statement |
| The build catalog, `schema_migrations`, `sqlite_schema`, pragma functions | The per-query authorizer, scoped to one physical table |
| Another table in the same build | The same |
| `readfile`, `writefile` | They do not exist: `node:sqlite` is built without them |
| A statement above 100,000 characters | The request schema, before anything is parsed |
| A runaway recursive CTE | A five-second deadline, enforced by killing the child process |

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
| A PDF with no text layer | A warning, and it contributes nothing. OCR is out of scope |
| A file whose bytes are not readable text | Excluded at fingerprinting, with a warning |
| A table past a column or row limit | Excluded with a warning; the build succeeds (#242) |

## The write surface

There is one: `ApiOptions.localActions`, supplied only by `lore dev`, refusing every browser
origin that is not a loopback literal. A runtime built without it has **no mutating route at
all**, which the end-to-end suite asserts by requesting each one and expecting a typed 404.

That is checked by **registration rather than by HTTP method**, because
`POST /v1/tables/:id/query` is a read: a SQL statement does not belong in a URL. A method-based
check would either exclude the query route or admit a genuine write that happened to be a `GET`.

## What is not covered here

- **Cross-platform runs of these suites.** `verify` runs on macOS, Windows and Linux in CI, so
  they execute everywhere; what is untested is any platform-specific escape, such as an NTFS
  alternate data stream.
- **A deployed runtime.** Everything above is the local boundary. Phase 6 adds a remote one, and
  #86 carries the criterion that no administrative route exists in the Worker.
- **Authentication.** There is none locally, by design: the server binds loopback and serves one
  project. Bearer auth for the remote surface is #90.
