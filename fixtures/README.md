# Parser fixtures

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
