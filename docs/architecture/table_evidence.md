# Table conversion evidence

CSV and XLSX parsers store `tableEvidence` version `1` in each imported table's metadata.
`formulaColumns` contains sorted zero-based imported column ordinals. CSV formula-like text
remains literal. XLSX presence covers imported data independently of the existing 1,000 raw
formula-expression cap; cached values are retained without evaluating expressions.
`conversionWarnings` records actual code/message pairs for that table. A sheet warning
must not leak into a different sheet's evidence. CSV parser `0.1.2` and XLSX parser `0.1.4`
give this changed evidence a new build identity. Table-bearing parses already bypass the
parse cache; a distinct parser version prevents reusing an older sealed build as well.
Global build normalization stays `2`; parser-local table normalization stays `1`.

Historical builds without this metadata do not establish formula absence or an empty
conversion-warning list. Public readers must preserve that distinction.

## Description contract

`describeTable` exposes `columns[].formula` as `present`, `absent` or `unknown` and
`conversionWarnings` as actual `{code, message}` pairs. Historical missing metadata returns
`unknown` per column and `null` warnings. Newly recorded empty warnings return `[]`.
Formula presence covers imported data in the column, not every sampled cell. It does not
claim the cached value is current. Samples and query results keep the stored cached value.
Local SQLite and Cloudflare D1 use the same metadata reader and their existing queries.
CLI `inspect tables <id> --json`, HTTP, MCP and SDK expose these fields. CLI text and Studio
show the markers, warning diagnostics and the fact that workbooks are never evaluated.

See [ADR0036](../adr/0036-table-conversion-evidence.md).

Formula-element presence is tracked separately from retained expression text. Shared-formula
followers can omit the expression; formulas without cached values remain null. A formula-only
row with no cache is retained as data, rather than discarded as an empty spacer row.

Studio's named schema and sample/query scroll sections are focusable so keyboard users can
scroll overflowing columns. This follows [MDN's overflow accessibility guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow#accessibility).
Local lint exceptions preserve that required keyboard behavior; the browser test checks actual
Arrow-key scrolling and axe at desktop/mobile sizes. The general lint policy is unchanged.
