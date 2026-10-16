# Gate strict builds on declared source coverage

## Status

Accepted. Implementation and qualification are tracked in #412.

## Context

A successful parse may still omit PDF pages or worksheet data. Existing warnings describe
that loss, but cannot express which inputs a project requires before activating a build.
Informational conversions are different from lost source content.

## Decision

Declare exact canonical project-relative files and optional exact worksheet names under
`build.required`. `build.profile` defaults to `permissive`; `strict` rejects unavailable
required inputs or known content loss before candidate sealing, registration and activation.
A whole workbook declaration covers every sheet; a sheet declaration scopes worksheet loss
to those sheets. File declarations use project-relative paths to distinguish source roots.

Use exact paths rather than globs: an ignored directory is deliberately not enumerated,
so a glob cannot establish which unseen files were required. Explicit declarations remain
checkable without reopening excluded directories or changing discovery limits.

Parsers mark known content loss in their warning port, with optional sheet scope. The compiler
consumes this format-independent evidence and imported sheet metadata; it does not interpret
human warning strings or import parsers. Existing fatal parse errors remain fatal in either
profile. No automatic completeness or truth inference is introduced.

Canonical effective configuration includes the profile and sorted declarations. Advance
product defaults and parse-cache versions so old cached warnings cannot omit loss evidence.
Operational parser budgets and immutable build identity rules remain unchanged.

## Consequences

A project can opt into an actionable, typed build failure while preserving the previous
active version. Permissive builds keep coverage diagnostics in existing warning surfaces.
Future parser omissions must carry loss evidence. The gate covers declared requirements and
known omissions; it cannot detect OCR content or invent unsupported extraction capabilities.
Manual activation of an already verified build remains an explicit lifecycle operation.
