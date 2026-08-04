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
