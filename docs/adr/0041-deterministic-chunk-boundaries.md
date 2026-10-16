# ADR0041: deterministic Unicode chunk boundaries

## Status

Accepted for v0.1.0. Tracked in #591.

## Context

UTF-16 offsets can split a surrogate pair. SQLite replaces the resulting lone
surrogate with U+FFFD, losing the source character in the immutable catalog.
The existing overlap expression also always selected the end of the last piece,
so the configured overlap had no effect. Old parse-cache keys omit the algorithm.

## Decision

Split on code-point boundaries, retaining the existing paragraph, line and word
preferences. Start overlap within the configured cap and the latter half of the
previous piece. Prefer a whole word when available and always advance.

Use explicit CHUNKER_VERSION 2 in every parse-cache key. Keep the normalization
policy independent. Do not use ICU-dependent grapheme segmentation, which could
make identical source produce different chunks across Node installations.

## Consequences

Changed chunk text changes the existing logical chunks root and build ID. An
unchanged source is reparsed once after this algorithm change, then eligible cache
reuse resumes. Retained builds are not rewritten. Combining sequences can span
chunks, but no valid surrogate pair loses its characters. No new dependency or
runtime prerequisite is introduced.
