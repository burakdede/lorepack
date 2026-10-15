# Version case-insensitive credential defaults

## Status

Accepted.

## Context

Issue #633 shows that mixed-case credential filenames reach discovery while lowercase
variants are excluded. Init uses the same rules and misses these names too. Making all
patterns case-insensitive would change project rules and explicit negations.

## Decision

Give each compiler ignore rule an optional `nocase` flag, interpreted by both path and
directory matching. Enable it only for `SECRET_SHAPED` default rules, including init's
secret-only matcher. Preserve case-sensitive matching for other defaults and every
`.loreignore` rule. Later rules still win, so an exact negation can explicitly opt in.

Bump `DEFAULTS_VERSION` to2. Architecture sections11.4 and19.2 require input selection to
be a versioned policy: the pattern list has not changed, but its meaning has. The version
already belongs to canonical effective configuration and therefore build identity.

## Consequences

Mixed-case credential names are excluded consistently at every depth and on every OS.
Existing immutable builds remain readable; new builds receive new identities, including
projects without credential files. Init describes exclusion by default because explicit
negations remain supported. This filename guardrail does not inspect file contents.
