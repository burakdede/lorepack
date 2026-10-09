# Limitations

What v0.1 does not do, stated plainly so nobody finds out the hard way.

- **Markdown, HTML, DOCX, CSV, XLSX, text-layer PDF, plain text and source code.** A file with
  an extension Lorepack does not know is named in the build's exclusions rather than silently
  skipped. A fully scanned PDF is refused outright, the active build remains unchanged, and the
  error names OCR as the remediation. OCR is out of scope for v0.1.
- **A spreadsheet becomes a typed table, not prose**, queried with SQL rather than searched as
  text. Types are inferred conservatively and refuse to be clever: `00123` stays text, a
  19-digit id stays text, and `03/04/2026` stays text because the file never says which country
  wrote it. Excel formulas are stored as text and never evaluated. A worksheet whose layout is
  not a table is described and reported, never invented into one.
- **The SQL surface is one read-only SELECT over one table**, run in a process that is killed on
  a deadline, behind an authorizer that permits that table and nothing else in the build. It
  cannot write, cannot reach another table, and cannot read the catalog.
- **Lexical retrieval only.** BM25 with declared ranking hints. No embeddings in the default
  install, and the score is presented as a ranking heuristic because that is what it is. The
  Cloudflare target is lexical-only in v0.1.
- **No screenshots, OCR or image understanding.**
- **No PPTX.** Presentation parsing is out of scope for v0.1.
- **One project, one machine.** No tenancy, no accounts, no hosted control plane.
- **The scale envelope is 2,500 files and 1 GB.** Past that Lorepack asks you to confirm, and
  says plainly that the behaviour is untested rather than unsupported. The measurements are in
  [performance v0.1](compatibility/performance-v0.1.md).
- **Precedence is declared, never detected.** Lorepack will not tell you which of two documents
  is correct, and does not claim to have found a conflict.

How each format is read, and what is deliberately dropped, is in
[parsers](architecture/parsers.md).
