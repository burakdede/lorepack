# Path and pattern normalization

## Status

Accepted for v0.1 (issue #589).

## Context

Paths are canonical NFC strings, but ignore and declared rule patterns previously
kept their original spelling. A decomposed pattern could silently fail to exclude
or rank the canonical path it names. Effective rule configuration also participates
in build identity. Ordinary names beginning with two dots were mistaken for parent
components, and distinct raw filenames could collapse to one canonical artifact ID.

## Decision

Normalization policy 2 applies NFC to ignore patterns and declared match/supersedes
globs, including their effective configuration before hashing. Keep arbitrary content
and the canonical serializer unchanged. Preserve case, negation and glob grammar.
Containment checks reject parent components and absolute relative results; ordinary
names such as `..notes.md` remain valid. Detect distinct raw paths with one canonical
artifact identity before indexing, refuse them with `LORE_E_CASE_COLLISION` and name
both paths. Never select a winner. Report skipped special files without opening them.

Increment the existing normalization policy version to 2. Readers explicitly retain
version 1 because its canonical NFC records and logical catalog remain verifiable by
the same algorithm. Reject unknown versions. Validation binds the recorded version
into the build ID and must never rewrite an older package or rebuild its sources.

## Consequences

New builds and parse cache keys carry normalization version 2, so build IDs change
across this policy revision. Newly compiled NFD and NFC rule spellings have identical
effective input identity. Old immutable builds remain readable and independently
verifiable; they are not silently migrated. The project-root anchoring decision in
ADR0038 remains separate, and is retained during integration. Linux must exercise
real NFC/NFD duplicate filenames because normalization-insensitive APFS cannot hold
both. Windows named pipes are not POSIX filesystem socket entries.

Windows preserves Unicode filename spellings under its [file naming contract](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file), so both Linux and Windows exercise the real collision fixtures. Only the normalization-insensitive macOS fixture is skipped.
