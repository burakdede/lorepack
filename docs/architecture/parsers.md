# Parsers

A parser turns bytes into the canonical node tree and nothing else. It reads no files, keeps no
state, consults no clock and no configuration, so it is deterministic by construction rather
than by discipline. `packages/parsers/src/shared/` holds what they share: node ids from an
ordinal path, locator construction, and strict decoding.

| Format | Reads with | Phase |
|---|---|---|
| Markdown | `remark` + GFM + frontmatter | 1 |
| Plain text and source code | line and paragraph structure | 1 |
| HTML | `rehype-parse` | 5 |
| PDF (text layer) | `pdfjs-dist` | 5 |
| DOCX | `mammoth`, normalized through the HTML parser | 5 |
| CSV | `csv-parse` | 5 |
| XLSX | [our own reader](./adr-xlsx-parser.md) over `yauzl` and `sax` | 5 |

## A parser may return a promise

See [build orchestration](./build-orchestration.md#a-parser-may-return-a-promise). PDF and DOCX
leave no choice, and the load-bearing part is the `await` at the call site rather than the
signature.

## Two rules that hold for every parser

**A parser never infers status, authority or supersession.** `buildArtifact` sets every artifact
`active`, authority 50, superseding nothing, and the rule stage decides otherwise afterwards
(section 12.7). A parser that read `authority: 100` out of a document would be letting a
document promote itself, which is inventing truth.

**A parser never emits markup.** Node text is built from text nodes only, so an attribute, a
comment or a `<script>` body cannot reach a build however the document is shaped. This is a
property of the construction rather than of a sanitising pass, which is what makes it hold for
input nobody anticipated.

## HTML

`rehype-parse` is the same unified toolchain as Markdown, so heading stacking, node ids and
locators are shared rather than reimplemented, and it reports source positions, which is what
makes exact line ranges possible. It is parsed as a whole document, so the HTML specification's
error recovery applies: an unclosed tag or a stray `</div>` is repaired the way a browser
repairs it. Malformed markup is the normal case, not the exceptional one.

This parser is also the one **DOCX normalizes through**, so every decision here is made twice:
once for a `.html` file and once for a Word document that became HTML.

### The noise policy is versioned data

`packages/parsers/src/html/policy.ts` lists what is removed, and
`HTML_NOISE_POLICY_VERSION` is part of what the parser version covers. **Dropping an element
changes what a build contains**, so editing that file without bumping the version would let two
builds with the same id hold different text.

It is a **deny list, not an allow list**. An allow list silently drops every element nobody
thought of, and HTML in the wild is mostly elements nobody thought of. Denying by name means an
unfamiliar element keeps its text, so the failure mode is "too much survived", which a reader
can see, rather than "the page came out empty", which they cannot.

Two groups, for different reasons:

- **Dropped with their contents**: `script`, `style`, `iframe`, `svg`, form controls and the
  rest. Their text is code or interface, not prose. `script` and `style` are the
  security-relevant pair, because indexing them puts executable-looking strings into search
  results and context bundles.
- **Site chrome**: `nav`, `header`, `footer`, `aside`, but **only outside `article` and
  `main`**. That distinction is the whole point. A `<header>` at page level is a logo and a
  menu; a `<header>` inside an `<article>` is that article's own opening, and dropping it would
  remove the document's title.

A page that is more than half chrome produces an `html-noise-removed` warning naming the
elements, because "why is most of my page missing" is a question the build should answer before
it is asked (section 24.4).

### Whitespace, and why the order matters

Every run of source whitespace, newlines included, collapses to one space **first**; only then
do block boundaries become newlines. Inside a paragraph, a line break in the markup is not a
line break on the page. Collapsing in the other order leaves `lots\n   of` as two lines, which
is exactly what a browser does not render.

### HTML tables stay text

An HTML table becomes a `table` node holding its cell text, **not** a typed SQL table. Only CSV
and XLSX become queryable tables in v0.1.

The reason is that section 12.6's import needs a header row, a column count that holds for
every row, and types inferred from a bounded sample. An HTML table offers none of that
reliably: it is a layout device as often as a data structure, `colspan` and `rowspan` make the
grid ragged, and nested tables are common. Guessing a schema from that would produce a typed
table whose columns are a fiction, and a wrong schema is worse than no schema because it is
queryable. The text is preserved and searchable, with the row count in metadata.

### Encoding is the one place decoding is not strict UTF-8

Everywhere else, a file that is not UTF-8 is excluded, because guessing an encoding produces
plausible nonsense. HTML differs in kind rather than in degree: a page carrying
`<meta charset="windows-1252">` is not ambiguous, it is **labelled**, and honouring a label is
not guessing. A legacy documentation export is exactly the file someone points Lorepack at.

- A declared encoding is honoured when the platform can decode it, with a warning recording
  what was used.
- An undeclared file is UTF-8, per the specification's default, decoded strictly.
- **Nothing is sniffed.** There is no statistical detection. Without a declaration there is no
  second guess, and an undeclared file that is not UTF-8 is refused with a message naming
  `<meta charset>` as the fix.

Links are kept in node metadata rather than inlined into the prose, so a reader can follow one
without every paragraph being polluted by URLs.

## PDF

Text layer only, on `pdfjs-dist` (Mozilla, Apache-2.0, 22.1M weekly, zero dependencies).

### Two corrections to what #72 assumed

**The legacy build is necessary and not sufficient.** The ticket recorded "use the legacy build
rather than polyfilling `DOMMatrix`". That was true only while `@napi-rs/canvas` happened to be
installed, because canvas supplies `DOMMatrix` and pdfjs picks it up silently. Once canvas is
removed, and it must be, the legacy build throws at **module load**:

```
const SCALE_MATRIX = new DOMMatrix();
ReferenceError: DOMMatrix is not defined
```

So the answer is the legacy build **and** three deliberately useless stubs, confined to
`packages/parsers/src/pdf/runtime.ts`. They exist to satisfy a module-level `new`; Lorepack
extracts text and never renders, so nothing calls them to do arithmetic. Writing a real matrix
would be worse, because it would look like rendering support that works.

**Canvas is excluded at the lockfile.** It is an `optionalDependency` of pdfjs, which reaches
for it at runtime if present, and it is native, so `pnpm-workspace.yaml` carries
`overrides: {'@napi-rs/canvas': '-'}`. `check:no-native` already banned the name; the override
is what makes that check pass on a real install rather than only after someone deletes a
directory. Verified by wiping `node_modules` and reinstalling.

`isEvalSupported: false` is deliberately **not** passed. That option and every reference to it
were removed in pdfjs 6, which no longer evaluates anything, so passing it would be reassuring
rather than true.

### A page is the only structure

A PDF has no headings, only text that happens to be larger. Inferring a hierarchy from font
size would put structure in the build that is not in the document, and every locator beneath it
would be a claim nobody made. So the parser emits one `section` per page titled `Page N`, with
paragraphs under it, and the locator carries the page because that is the only coordinate the
document actually has.

### What is refused, and why refusing matters

A document whose pages carry no text at all is **refused**, with a message naming OCR as out of
scope, rather than producing an empty artifact. An empty artifact is the worst outcome
available, because it looks like a working build. A partly scanned document is kept, with a
warning counting the pages that gave nothing.

Password-protected documents fail with a message saying Lorepack never prompts for a
credential: a build is not an interactive session, and a parser that asked would hang CI rather
than fail it.

One damaged page does not fail the document. It becomes a warning naming the page, which is
section 24.4's visible loss rather than a build that dies on page 400 of 600.

### Hyphens: the conservative choice, stated

`depart-\nment` is one word split by typesetting. `long-\nterm` is a compound that wrapped at
its own hyphen. **Nothing in the text layer distinguishes them**, and the two repairs disagree.

The line is joined without inserting a space and the hyphen is kept. That is not neutral, it is
conservative: keeping the hyphen preserves what was on the page, while removing it fabricates a
spelling that appears in no document. Ligatures are the opposite case and are expanded, because
those codepoints have exactly one expansion and leaving them makes a word unsearchable.

## DOCX

`mammoth` converts, and **the HTML parser builds the nodes**. One set of node-construction
rules and one normalization path, rather than a second structure extractor that drifts from the
first. It is why #71 landed before #73.

### Why mammoth here, when XLSX went the other way

Worth stating so the two decisions do not look inconsistent.

mammoth **meets the bar**: BSD-2, 6.9M weekly downloads, five releases in two years, no native
code, no post-install script. ExcelJS failed on maintenance and `read-excel-file` on
capability; neither is true here. And the jobs are not comparable. A spreadsheet is a grid of
typed cells and its reader is a few hundred lines. A Word document is style inheritance,
numbering definitions, footnotes, revisions and section properties, and reimplementing that
would be a large surface with quiet failure modes.

The cost is recorded rather than hidden: mammoth pulls `jszip`, a second ZIP implementation
alongside the `yauzl` the XLSX reader uses. Accepted deliberately.

**Re-check due 2026-08-04 plus one year**, or sooner if releases stop appearing. A library
going quiet is exactly the trigger that produced #113.

### Styles, not appearance

A heading in Word is a paragraph wearing the `Heading1` style, not text that happens to be
large, so mapping styles is reading what the author declared rather than guessing from
appearance. That is section 4.4's requirement, and the same principle that makes the PDF parser
refuse to infer headings: there, no declaration exists to read.

A style with no semantic equivalent is **named in a warning**, deduplicated, once per style
rather than once per paragraph. That information exists only at conversion time: once the HTML
is produced, a paragraph styled `CustomCallout` is indistinguishable from one never styled.

### A DOCX has no pages

Word paginates at render time against a page size, a font set and a printer, so a page number
is a property of a rendering rather than of the document. Locators carry the heading path and
the ordinal position, and the artifact records `pagination: none` with the reason. A reader who
expects `page` should learn why it is absent from the build itself.

### Two refusals worth their own messages

- **`.doc`** is refused by name. It is a different format that shares three letters, and letting
  it through produces "could not find the body element", which sends someone hunting for a
  corrupt file rather than reaching for save-as.
- **A password-protected document** is an OLE container rather than a ZIP, so it fails at the
  archive layer with a message about a central directory. That is translated into one naming
  the likely cause and stating that Lorepack never prompts for a credential.

### Text that looks like markup

Word stores the characters, mammoth escapes them to `&lt;script&gt;`, and the HTML stage decodes
them back, so a paragraph written *about* script tags survives **as text**. It was never an
element, so there was nothing to execute, and equally nothing was deleted. The dangerous
direction is the second: unescaped characters would become a real `<script>` element that the
noise policy drops with its contents, and an author's paragraph would vanish silently.

## CSV

A CSV becomes **a typed table plus one node that describes it**. Never rows of prose.
Architecture section 4.6 calls the alternative an invalid implementation, and the structural
guarantee is easy to state: row count does not affect node count. Three rows and three hundred
thousand rows both produce one `document` and one `table` node.

That node exists so retrieval can find the table. It names the file, the column names and
their types, the row count and the first few rows. Someone searching "shipping cost by region"
matches it, and then queries. What they never get is 300,000 rows joined with commas, which no
model can aggregate and no locator can cite.

### The one rule that matters: never invent a number

Type inference is written to **refuse** types, not to find them. Each candidate is asked "could
*every* non-null value in this column be this?", most specific first, and anything short of
unanimous falls through to `text`.

Four refusals, each of which corresponds to data destroyed somewhere in the real world:

| Value | Naive reading | What Lorepack stores | Why |
|---|---|---|---|
| `00123` | `123` | `'00123'` text | A postal code, extension or part number. The zero never comes back. |
| `+441632960000` | `441632960000` | text | A phone number wearing a plus sign. |
| `9007199254740993` | `9007199254740992` | text | Past `Number.MAX_SAFE_INTEGER`, so it returns changed and silent. |
| `03/04/2026` | a date | text | March 4th in one country, April 3rd in another. The file never says which. |

Only ISO-8601 shapes become `date`, and only if the date can exist: `2026-02-30` matches the
pattern and is not a day.

The bias has a cost, and it is the right one. A price column where one cell reads `n/a` stays
text and has to be cast in SQL. Casting is a keystroke. Recovering a leading zero that the
build discarded is impossible.

### Sample, then verify

Types are decided from the first 1,000 rows, because typing 500,000 rows twice is the import.
Every remaining row is then checked against that decision, and a column whose late row does not
fit **widens to text** rather than storing a null. Widening is announced in a warning, because
a user who expected to sum that column needs to know why they now cannot. The sample size is
recorded in table metadata, so the decision is auditable rather than magic.

### Reading the grid as arrays, on purpose

`csv-parse` offers `columns: true`, which returns objects keyed by header. Lorepack does not
use it, and this was measured rather than assumed:

- Given `a,a`, it returns **one** column and lets the second value win. A column of the user's
  data disappears with no warning.
- Given a row with an extra cell, it **discards the cell**.

Both are exactly the silent drops this parser is required not to do. Reading arrays means
raggedness is a length the parser can see, so a short row's missing cells become nulls, an
extra cell becomes a real column, and either way a warning names the line numbers.

### The two guesses, both written down

A CSV does not record its delimiter or whether row one is a header, so both are inferred and
both are recorded in table metadata alongside the reason.

The delimiter is chosen by **consistency, not frequency**. Counting occurrences is the obvious
approach and it is wrong: a semicolon-separated file of prose has more commas than semicolons.
The test is which candidate splits every sampled line into the *same* number of fields, counted
outside quotes so that `"Smith, John"` is one field.

Row one is a header when every cell it has is non-empty text and none of them parse as a number
or boolean. A header narrower than the widest body row is still a header; the unnamed columns
get positional names rather than demoting the header to data. Duplicates become `name_2`, and
that too is a warning, because renaming a column is a decision the reader should see.

### Limits

100 columns and 500,000 rows, both hard failures with the count and the limit in the message.
The column limit matches Cloudflare D1's, so a table that imports locally can be projected in
Phase 6 rather than failing there for the first time.

Measured at the envelope on 2026-08-04: a 500,000-row, five-column file (21 MB) parses in
1.7 s and imports in 0.4 s, holding about 360 MB above baseline. The whole file is read into
memory rather than streamed, which is deliberate: the parser port hands over `bytes`, so the
file is already resident, and a streaming reader would add a second code path while saving
nothing.

## XLSX

Read by **a reader of our own**, over `yauzl` (already vendored for `.lorepack`) and `sax`.
Architecture section 8.7 named ExcelJS; [`adr-xlsx-parser.md`](./adr-xlsx-parser.md) supersedes
that line with the measurements behind it. In short: nothing maintained returned formula text,
cell addresses, merge ranges and bounded memory together, and an unmaintained parser of
untrusted binary input is the worst possible dependency to accept.

An `.xlsx` is a ZIP of XML parts. The reader touches five of them: `workbook.xml` for sheet
names and the date system, `workbook.xml.rels` to resolve each sheet to its part,
`sharedStrings.xml`, `styles.xml` for the number formats, and one sheet part per worksheet.
Not charts, pivot tables, drawings, macros or styling.

### The refusal is the feature

A worksheet is a canvas, not a table. People put a title in A1, leave a blank row, start the
data at A3 and add a total row at the bottom. The detector looks for the first row of all-text
cells sitting above a row of data of the same width, skips whatever is above it (saying so in a
warning), and **refuses** when it finds nothing.

That refusal matters more than the detection. Flattening a workbook into prose is forbidden by
section 4.6, but inventing a table out of a layout nobody meant as one is the other failure and
the quieter one: it produces confident, queryable, wrong data. A sheet the detector cannot read
becomes a descriptive node and a warning naming the sheet.

### Provenance is a cell range

Section 10.8 wants a queried row traceable to where it came from, so a table's locator carries
`sheet` and `cellRange` (`Invoices!A2:F5`), not an ordinal in a file that may hold several
tables. The range is computed **after** the sheet is read: computing it in the detector, which
runs as soon as the header is found, reported `A1:D24` for a 500,000-row sheet.

### Formulas are text

`=D3+E3` is stored as `D3+E3` in table metadata, beside the cached value Excel wrote in the
cell. Lorepack has no formula engine and must never appear to have one: if a workbook's cached
value is stale, the build reports the stale value, because that is what the file says. This is
section 12.6 step 5, and it is the capability that eliminated `read-excel-file`, which returns
`49.95` for a cell holding `=C2*D2` and offers no way to see the formula.

### Three cases that fail quietly

Each of these is handled because a library would have handled it invisibly and our reader will
not:

| Case | What goes wrong without it |
|---|---|
| **Inline strings** (`t="inlineStr"`) | Some writers never build the shared table. A reader that only handles `t="s"` returns empty columns and the file looks like it had no data. |
| **The 1904 date system** | Set per workbook. Read as 1900, every date moves by exactly 1,462 days and still looks like a perfectly ordinary date. A warning records which epoch was applied. |
| **Error cells** (`t="e"`) | `#REF!` coerced to null claims the cell is empty; coerced to a bare string in a numeric column it reads as data. It is kept as its own text, and its column is typed `text`. |

Two more traps worth naming. An Excel date is **a number plus a style**, so detection needs
`cellXfs` to `numFmtId`, the builtin date ids **and** custom `formatCode`s, with `[...]`
sections and quoted literals stripped first (otherwise `"Sales day"#,##0.00` turns every price
into a date). And the 1900 epoch bases at **December 30th, 1899**, which cancels the leap-year
bug Lotus shipped in 1983 and Excel kept.

Sheets are resolved through relationships rather than by sorting `sheet1.xml`, `sheet2.xml`:
deleting a sheet does not renumber the parts, so `sheet3.xml` can be the second sheet.

### Hardening is ours

Because there is no library in between, section 20.9's requirements are enforced here: a part
declaring a `DOCTYPE` is refused outright, decompressed bytes are budgeted **as they arrive**
(a cap checked afterwards is not a cap), and part, sheet, row and column counts are capped.
Verified separately that `sax` in strict mode does not expand custom entities at all: an XXE
payload and a billion-laughs payload both yield a parse error and the literal `&x;`. The
DOCTYPE refusal stays anyway, because a guarantee we depend on should be one we assert.

### Measured at the envelope

On 2026-08-04, 500,000 rows across 2,000,000 cells (11 MB compressed): **6.5 s**, and **16 MB
above baseline to stream the sheet**, with the materialised table bringing the total to about
98 MB. Both beat the ADR's budget of 85 MB and 14 s. The split is the number to watch: the
streaming figure is flat in sheet size, so if it grows, something has started accumulating.

Note also that `sax`'s stream has no `destroy`, so `source.pipe(parser)` dies under
backpressure with `TypeError: dest.destroy is not a function`, reported as a corrupt workbook.
The reader writes chunks in explicitly instead.

## Every parser: two things the build does with the result

Worth stating here rather than in each section, because both were once true of no parser and
are now true of all of them.

**A binary format is exempt from the text check.** Fingerprinting refuses any artifact whose
bytes are not valid UTF-8, which is right for a document and fatal for a container. Formats
declare `readsBytes` in the registry, and the fingerprint stage skips the decodability verdict
for them. It still hashes them: the exemption is about readability, not identity. Without it
every `.docx` and `.xlsx`, and every `.pdf` with a compressed stream, was dropped from the
build and reported to the user as "appears to be binary" (#222).

**Parser warnings reach the manifest.** Everything a parser decided and admitted to, a heading
flattened, a column widened, a sheet not read as a table, is collected into the build's
warnings with the artifact's path and the `parser` class. They are cached alongside the parse,
so a warm rebuild reports the same warnings as a cold one; a warning that appears only
sometimes teaches a reader that silence means nothing (#223).

## Typed tables in a build

Rows live in real SQL tables inside the sealed build, described by a catalog. See
[`local-storage.md`](./local-storage.md#typed-tables) for the schema and the naming rules.
