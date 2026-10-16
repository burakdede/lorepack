# Table conversion evidence

CSV and XLSX parsers store `tableEvidence` version1 in each imported table's metadata.
`formulaColumns` contains sorted zero-based imported column ordinals. CSV formula-like text
remains literal. XLSX presence covers imported data independently of the existing1,000 raw
formula-expression cap; cached values are retained without evaluating expressions.
`conversionWarnings` records actual code/message pairs for that table. A sheet warning
must not leak into a different sheet's evidence. Parser version0.1.1 invalidates old parse
cache entries so missing evidence cannot be mistaken for known absence.

Historical builds without this metadata do not establish formula absence or an empty
conversion-warning list. Public readers must preserve that distinction.
