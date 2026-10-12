# Logical package verification

## Status

Accepted.

## Context

An archive's checksum index can be rewritten with its payload. Member integrity alone
cannot establish that a catalog and its build ID agree. SQLite files are untrusted input;
verification must also bound native execution rather than relying on a JavaScript timer
around synchronous queries.

## Decision

Retain the exact canonical build-ID inputs when sealing new builds. After streaming archive
checksums, validate the supported catalog schema, content hashes, typed rows, derived FTS
projection and declared rules. Recompute all canonical roots and the build ID. Require
each referenced normalized object at its verified content address.

Compare FTS term instances and document sizes with an independently populated scratch
index using SQLite's [FTS5 vocabulary interface](https://www.sqlite.org/fts5.html#the_fts5vocab_virtual_table_module).
The scratch index is stored on disk inside the private verification directory. Temporary
vocabulary tables read the packaged catalog; its main database remains read-only.

Run catalog checks in a separate Node process, using the existing read-only SQLite adapter.
Disable trusted schema, extension loading and inherited environment variables. Bound the
process deadline, JavaScript heap and reply size. Copy only fixed verification files into
a private temporary directory and remove it on every outcome.

Report integrity only and an unsigned publisher. No parser re-execution, signature system,
source correctness assertion or trusted-builder claim is part of this contract.

## Consequences

Previously sealed builds without identity inputs remain usable as retained builds, but
their archives cannot satisfy independent logical verification. Refuse those archives
explicitly rather than altering immutable directories or inventing missing inputs.

Physical SQLite and ZIP bytes remain excluded from canonical identity. Compatible schema
definitions are generated from shipped migrations; unexpected tables, views, triggers or
physical table definitions fail closed. Existing normalization v1 emits two node revision
recipes; verify content against either recorded recipe without changing build identity.

The child heap bounds JavaScript allocations, not all native SQLite memory. Archive byte
caps and the process deadline bound input and execution separately. Extraction and runtime
consumption remain independent work in issue #419.
