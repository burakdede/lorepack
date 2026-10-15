# Test fixtures

`documents/` contains committed source bytes; `expected/` contains canonical parsed
outputs with matching paths and a `.json` extension. The shared golden test covers
seven parser adapters and all eight supported format IDs, including separate text
and code cases. Markdown and HTML expected outputs are preserved.

| Source | Structural contract |
|---|---|
| `markdown/product-strategy.md` | Existing headings, paragraphs, list and locators |
| `html/documentation-page.html` | Existing cleaned article hierarchy and table |
| `text/operations.txt` | Two paragraphs with original line ranges |
| `code/deployment.ts` | Two code blocks at lines 1-3 and 5 |
| `pdf/release-guide.pdf` | Text on pages 1 and 3, visible warning for blank page 2 |
| `docx/release-guide.docx` | Release/Rollback headings, paragraphs and owner table |
| `csv/pricing.csv` | Two typed product rows with boolean and numeric cells |
| `xlsx/pricing.xlsx` | Products/Owners sheets, cell ranges and cached formula `B2=10+2.5` |

All sources are repository-owned test material. The new binary sources were written
with the existing test-only `makePdf`, `makeDocx` and `makeXlsx` helpers in
`tools/test-support/src/`. They are checked-in PDF/OOXML bytes, not generated while
the golden test runs. ZIP container metadata is part of those source bytes; changing
a binary fixture deliberately changes its artifact digest.

Run the normal comparison:

```sh
pnpm exec vitest run packages/parsers/test/golden.test.ts
```

After an intentional parser or source change, regenerate and review the full diff:

```sh
UPDATE_FIXTURES=1 pnpm exec vitest run packages/parsers/test/golden.test.ts
```

Expected output includes complete artifact/node/warning data and typed tables when
present. Do not remove locators, formula metadata, warnings or hashes to make a diff
pass. Separate landmark assertions check facts from the source fixture independently
of the generated expectations. These small fixtures establish regression contracts;
they do not qualify performance, arbitrary documents or release readiness.

## Source selector build

`builds/source_selector.lorepack` is a repository-owned synthetic build made by the
actual compiler and packer with Node24.21.0/SQLite3.53.4. It has five Markdown artifacts
in the distinct source roots `alpha`, `beta` and `omega`:

| Project-relative input | Body marker |
|---|---|
| `omega/z.md` | `ID_TARGET_BODY` |
| `alpha/omega:z.md` | `PATH_TARGET_BODY` |
| `alpha/z.md` | `DUPLICATE_PATH_BODY` |
| `beta/z.md` | `THIRD_DUPLICATE_BODY` |
| `alpha/omega/z.md` | `DISPLAY_ALIAS_BODY` |

The immutable build ID is
`lore_377479447fdd9340e72cc9498d6d812842dbae2db709b4f8341411198e373ed4`.
Original sources are excluded from the archive. Its metadata preserves the colon-containing
path, while all extracted member names are ordinary catalog/manifest/hash paths. Tests import
and verify this same archive on Windows, macOS and Linux; they do not create an illegal
Windows filename or skip the case.

Regenerate on POSIX after an intentional fixture change, then review the package proof:

```sh
pnpm build
node fixtures/builds/generate_source_selector.mjs
pnpm exec vitest run packages/deploy-cloudflare/test/source_selector.test.ts
```

The generator creates and removes its own temporary project. Archive bytes may change with
packaging metadata; the logical build ID is the identity asserted above. These inputs test
source selection and provenance, not performance or release qualification.
