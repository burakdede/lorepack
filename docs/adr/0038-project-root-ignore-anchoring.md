# Project-root ignore anchoring

## Status

Accepted for v0.1 (issue #588).

## Context

The project-root `.loreignore` is described as gitignore-style, but discovery previously
matched patterns against each source-relative path. With `sources: [docs]`, the plausible
`/docs/private/` rule excluded nothing. A source-root warning would leave that surprise in
the first released contract. Git's [pattern specification](https://git-scm.com/docs/gitignore#_pattern_format)
anchors rules to the directory containing the ignore file.

## Decision

Match `.loreignore` against canonical project-relative logical paths. Keep slash-free
patterns effective at every depth and retain the existing last-match/negation behavior.
Prune excluded source ancestors before visiting a configured root, so an explicit deep
source cannot bypass a directory exclusion. Contents rules still allow negations when
the directory itself was not excluded. Exclusion samples name project-relative paths.

Keep artifact IDs, source locators and relative paths anchored to their declared source.
Linked sources use their declared project path for policy, preserving the same rule when
filesystem events report a real target path. Discovery, sweeps and event filters must use
the same policy. No matching grammar, normalization policy, dependency or runtime port changes.

## Consequences

With `sources: [docs]`, `/docs/private/` excludes private content, `/private/` names only
project-root private content, and `private/` excludes the name at any depth. Old anchored
source rules need their declared source prefix when that was their intent. `lorepack init`
states project-root anchoring in the generated file.

This change lands before v0.1 freezes ignore semantics. It affects selection in newly
compiled builds; existing immutable builds remain readable and are not rewritten. No
warning-only compatibility mode or hidden interpretation of old rules is added. Unicode
pattern normalization remains a separate issue (#589).
