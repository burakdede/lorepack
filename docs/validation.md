# Build validation

`lorepack validate` compiles configured sources and validates a candidate before
sealing it. It can update the parser cache and lockfile, but does not activate the
candidate. `--frozen` refuses lockfile changes. `--allow-large-project` controls the
existing compile scale gate.

```bash
lorepack validate --build lore_<full-lowercase-sha256>
lorepack validate --build lore_<full-lowercase-sha256> --json
```

With `--build`, validation verifies that exact retained build even if sources have
changed or disappeared. Keep the configuration, state database, selected build and
referenced objects. The selector requires a full build ID. Compile flags cannot
accompany this mode. It never falls back to the active build or compilation.

Verification holds a read owner until it finishes. It copies the catalog, manifest
and saved identity inputs into OS scratch and runs the existing read-only catalog
verifier there. Its reference FTS database is created in scratch, never inside the
immutable build. Checks cover supported migrations and schemas, SQLite integrity,
canonical content and rules, FTS parity, typed tables and rows, recorded locator
ranges and build identity. Normalized object checksums are streamed, not loaded as
complete bodies. Scratch files and ownership are released on success, failure and
cancellation. Source bytes, canonical build data and the active pointer remain
unchanged.

JSON returns `mode: "existing-build"`, the verified `buildId`, `ok: true`, named
successful `checks` and the unique referenced `objectCount`. This proves integrity,
not publisher authentication or document truth. Verification never creates or
rewrites a retained validation report.

## Candidate checks and reports

Newly compiled builds retain `reports/validation.json`: `ok`, `checksRun` and
`failures`, plus `checks` with each name and its boolean result. Each failure identifies its check, message and subject. A successful
report has no failures. Failed candidates are never sealed or activated.

`table-mapping` compares catalog identities, source mappings, generated physical
names, ordered column names/types/nullability, physical columns and row counts with
parsed tables. `locator-ranges` validates locator shape and artifact/path ownership,
ordered positive line ranges, recorded document extents and PDF page counts, sheet
membership and valid ordered cell ranges within recorded sheet extents. It covers
nodes, chunks and structured tables. Candidate validation also checks the stored
SQLite coordinates against the parsed bounds so a catalog-write defect cannot
pass solely because the in-memory parse was correct.

Range checks use parser-recorded bounds without extracting original sources. A
format without a recorded line/page/sheet extent cannot supply that upper-bound
proof. Present coordinates must still have valid shapes and order. These checks
do not claim row or cell lineage for SQL result values.

## Refusals and limits

Missing or pruned selections return `LORE_E_BUILD_NOT_FOUND`. Missing saved
`reports/build-id-inputs.json` or incompatible schemas/hashing versions return
`LORE_E_SCHEMA_MISMATCH`. Damaged identity, catalog, locator or object data returns
`LORE_E_OBJECT_CORRUPT`. Restore a verified compatible package: validation never
repairs stored data. Interrupting verification returns `LORE_E_CANCELLED`.

The catalog verifier has a timeout of 60 seconds, a heap ceiling of 128 MiB and a
reply cap of 4 MiB. Exceeding these existing limits returns `LORE_E_LIMIT_EXCEEDED`
without accepting a partial proof. Object hashing streams every referenced object
and can be cancelled. Catalog limits are not a total deadline for the command.
