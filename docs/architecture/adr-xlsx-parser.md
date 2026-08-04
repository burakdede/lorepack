# ADR: how Lorepack reads XLSX

**Status**: accepted, 2026-08-04. Resolves #113, unblocks #75.

**Decision**: read XLSX with a **read-only reader of our own**, built on `yauzl` (already
vendored for `.lorepack`) and `sax`. Do not adopt ExcelJS, and do not adopt any of the
alternatives surveyed.

Architecture section 8.7 named ExcelJS. This supersedes that line, for the reasons below.

## Why this needed deciding at all

`exceljs@4.4.0` was last published **2024-12-20**, one release in two years, and the
maintainers describe the project as inactive in their own issue thread
(exceljs/exceljs#2987). That fails the dependency rule in `AGENTS.md` section 9: libraries
must be *maintained and capability-matched*, not merely popular. XLSX parsing takes
**untrusted binary input**, which is the worst possible place to hold a dependency with no
security-fix pipeline, and section 20.9 requires malformed-Office-file hardening.

## What was required

From #113, in priority order: read-only, cell-level addressing, formula text, bounded memory
at the 500,000-row envelope, type fidelity, real maintenance and a permissive licence, and no
native code or post-install script.

## What was measured

Every candidate was installed and run against the same fixtures: a sheet with leading-zero
identifiers, Excel date serials, a formula, a merged range and two sheets; and a generated
500,000-row workbook (14 MB) for the envelope. Peak RSS was sampled every 50 ms.

| | ExcelJS 4.4.0 | read-excel-file 9.3.5 | **own (yauzl + sax)** |
|---|---|---|---|
| 1. Read-only | no, writes too | yes | **yes** |
| 2. Cell addresses | yes (`A2`, `G2`) | no, indices only | **yes** |
| 2b. Merge ranges | partial: `A5` | lost entirely | **full: `A5:B5`** |
| 3. Formula text | yes, `C2*D2` | **no**, cached result `49.95` | **yes** |
| 4. Memory @ 500k rows | 297 MB in 4.9 s | 899 MB in 6.2 s, no streaming API | **85 MB in 14.3 s** |
| 5. Leading zeros / dates | `"00123"`, `Date` | `"00123"`, `Date` | `"00123"`, date from `numFmt` |
| 6. Releases in 2 years | **1**, self-declared inactive | 36 | sax: released 2026-07-24 |
| 6b. Weekly downloads | 12.7M | 1.47M | sax: **85.5M** |
| 7. Native / post-install | none | none | **none** |

Two findings are worth stating plainly because they are the ones that decided it.

**`read-excel-file` cannot return formula text.** For the cell holding `=C2*D2` it returns
`49.95`, the cached result. Section 12.6 step 5 requires storing the formula *text* and never
evaluating it, so the value it returns is the one thing we must not record as content. This is
a capability failure, not a preference: no option or plugin exposes the formula.

**ExcelJS ships a vulnerability that will never be fixed.** `npm audit` on a tree containing
only ExcelJS reports a moderate advisory in `uuid@8.3.2` (missing buffer bounds check).
ExcelJS pins it, ExcelJS is not releasing, so the advisory is permanent for as long as the
dependency is. It is probably unreachable on a pure read path, but "probably unreachable"
is not a thing to write in a security policy, and #99 wires dependency auditing into CI.

## Why not the other candidates

- **`@office-kit/xlsx` 0.9.0**: 40,186 weekly downloads and two releases. Its `fromFile`
  returns a packaging object exposing only `toBytes`/`toStream`, not a read model. Pre-1.0,
  so the API carries no stability promise. Eliminated on adoption and maturity, which is the
  bar this project sets against choosing a library for its internet presence.
- **`@zurmokeeper/exceljs` 4.4.9**: 5,097 weekly downloads, last release 2025-02-26. The
  "maintained fork" premise is not supported by its cadence.
- **SheetJS `xlsx` on npm (0.18.5)**: distribution moved off the public registry in 2022, so
  the registry copy is four years old and misses fixes published elsewhere. `@e965/xlsx`
  (0.20.3, 877k weekly) is a third-party mirror, which substitutes a supply-chain question for
  a maintenance one.
- **`node-xlsx`, `xlsx-populate`, `xlsx-stream-reader`, `excel-stream`**: wrappers over SheetJS
  or stale since 2022.

## What we build instead, and what it costs

A read-only reader over the parts of ECMA-376 we actually need: `workbook.xml` for sheet
names, `sharedStrings.xml`, `styles.xml` for the number formats that tell a date serial from a
number, and the sheet XML for cells, formulas and merge ranges. Not charts, not pivot tables,
not drawings, not styling.

The spike that produced the numbers above is roughly 150 lines. That is the honest measure of
the surface: this is a narrow reader of a documented format, not a reimplementation of Excel.

It rests on two dependencies, and the point of the decision is that both are stronger than any
XLSX library available:

| | `yauzl` 3.4.0 | `sax` 1.6.1 |
|---|---|---|
| Already in the tree | **yes**, `.lorepack` reading | no, added by this decision |
| Weekly downloads | 12.5M | **85.5M** |
| Last release | 2026-06-21 | **2026-07-24** |
| Dependencies | 1 | **0** |
| Install weight | small | **80 kB** |
| Licence | MIT | BlueOak-1.0.0, permissive and Apache-2.0 compatible |
| Native code / post-install | none | none |

### What we gain besides maintenance

- **Better provenance than the library we replaced.** ExcelJS reports a merge as its anchor
  cell, `A5`. The reader gets the range, `A5:B5`, which is what section 10.8 asks a locator to
  carry.
- **3.5x less memory than the best library alternative** at the envelope, 85 MB against 297 MB,
  because nothing accumulates: the ZIP entry is streamed into a SAX parser and cells are
  emitted as they close.
- **Hardening we control.** The spike already refuses a `DOCTYPE` outright, which is the
  entity-expansion defence section 20.9 requires. With a library it would be an upstream
  feature request.

### This is the existing policy, not a new one

[`dependencies.md`](./dependencies.md) already says it: *"Prefer a small amount of our own code
over a dormant dependency when the code is genuinely small and fully testable."* The standing
example there is `ProjectLock`, written rather than take `proper-lockfile`, which had no release
since 2022. ExcelJS is the same situation with higher stakes, because a lock file is ours and a
spreadsheet is a stranger's.

The clause has two conditions and both hold. *Genuinely small*: the spike is ~150 lines for a
read-only subset of a published standard. *Fully testable*: it is a pure function from bytes to
nodes, which is the shape every other parser in this package already has, so the golden-fixture
harness needs nothing new.

### What it costs, stated honestly

- **It is ~3x slower than ExcelJS** at the envelope: 14.3 s against 4.9 s for 500,000 rows.
  Acceptable, because this runs inside a build, once, for the largest workbook the envelope
  permits, and memory is the constraint that ends a build rather than slows it.
- **We own the format edge cases.** Inline strings, the 1904 date system, error cells and
  unusual custom number formats are ours to get right, and each needs a golden fixture. #75
  carries that list.
- **We own the security surface**, which is the point rather than a cost: with an unmaintained
  library we would own it anyway and be unable to fix it.

## Consequences

- #75 implements the reader described here. Architecture 8.7's ExcelJS row is superseded and
  should be read alongside this ADR.
- `sax` is added to `@lorepack/parsers`. `yauzl` moves from a `backend-local` dependency to one
  shared with `parsers`.
- The 1904 date system, inline strings and error cells become required golden fixtures on #75,
  because they are the cases a library would have handled silently.
- If this reader ever needs to grow past a read-only subset (charts, pivot caches, styling),
  that is the signal to revisit, not to keep extending it.
