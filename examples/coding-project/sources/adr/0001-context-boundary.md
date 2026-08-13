# ADR 0001: Context Boundary

The sync worker reads from an immutable build directory. It must not read source files directly
after activation.

## Decision

Activation changes a pointer to a verified build. Rollback changes the pointer back to a
previous verified build. Neither operation recompiles.

## Consequences

A failed deploy can leave a receipt, but it cannot corrupt the active build. Recovery resumes
from the receipt or rolls back the pointer.
