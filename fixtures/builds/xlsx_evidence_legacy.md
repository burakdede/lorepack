# Legacy XLSX formula-evidence fixture

The sealed `xlsx_evidence_legacy.lorepack` was produced by the locally qualified C39 CLI
`c39e2b8ad38dd8181ca48ca6eadfd8a59e3fb0ed`. Its parser is `0.1.3`, build-identity
normalization is `2`, and parser-local table normalization is `1`. It has no
`tableEvidence`. The new evidence uses XLSX parser `0.1.4`.

The saved workbook has one Rates sheet with a formula `B2=1+1`, deliberately stale cached
value `999`, and an ordinary second row. Tests reuse these exact bytes. The
[provenance receipt](xlsx_evidence_legacy.provenance.json) records the workbook, archive
and producer hashes, exact commands and the actual executed recipe with its own hash.
Later formatting of the current generator cannot alter that historical recipe.

## Verify the upgrade

```sh
pnpm build
pnpm exec vitest run packages/cli/test/xlsx_evidence_identity.e2e.test.ts
```

The real CLI imports the old archive, checks unknown markers and warnings, rebuilds the
same project, and builds identical workbook bytes in a fresh project. It preserves old
build bytes and cached values while requiring a distinct XLSX parser identity. The original
red showed that an unchanged `0.1.3` reused the old build ID despite different fresh metadata.
Table-list paths are relative to the source root: `rates.xlsx` under source `docs`.
The artifact's project-relative inspection path is `docs/rates.xlsx`.

## Regenerate only from the recorded producer

Use Node `24.21.0` (SQLite `3.53.4`), npm `11.19.0` and pnpm `11.18.0` on POSIX.
The retained C39 tar must hash to
`182155b3102430d1c9da221bd3a362429535ea6df3ea09f3f4933d8b27820cf6`.
Run in an empty fixture destination, preserving existing qualified fixtures first:

```sh
node fixtures/builds/generate_xlsx_evidence_legacy.mjs /path/to/qualified-c39-cli.tgz 182155b3102430d1c9da221bd3a362429535ea6df3ea09f3f4933d8b27820cf6
```

The generator uses the existing source-only XLSX writer, installs the local producer tar
offline with scripts disabled, and drives its real build, inspect and pack commands.
Review the receipt before replacing a fixture. Tests import committed bytes on every OS.
