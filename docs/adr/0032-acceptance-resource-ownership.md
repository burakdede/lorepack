# 0032: Record acceptance resource ownership before provisioning

## Status

Accepted.

## Context

CI resource names also match valid production project slugs. Selecting older-looking names
cannot authorize deletion. Deleting a nonempty stale bucket also requires enumerating its
objects, which makes a mistaken ownership decision destructive. A crashed setup can leave
only one of the two D1 databases, before a target receipt is written.

## Decision

Use a persistent R2 ownership ledger in the configured test account. Check that a fresh
128-bit nonce namespace is unused, then write a versioned intent before invoking the real
CLI provisioning flow. Bind the intent to the account, test prefix, run and attempt. Derive
all resource names from that namespace; do not accept arbitrary resource names in records.
The existing R2 permissions suffice, and no additional service is needed.

Validate every ledger record before cleanup. Compare CI run metadata only after ownership
is established. Enumerate every object page before draining a bucket, and retire a record
only after all resource removals succeed. Keep the shared Worker outside stale per-run
selection; its existing CI concurrency group controls deployment and normal teardown.

## Consequences

One small persistent bucket and metadata requests are added to credentialed testing.
Partial provisioning and failed cleanup remain recoverable across runner loss. Malformed
records stop cleanup and require operator review. Legacy resources without a ledger record
require their original CI receipts for ownership review; their names alone are insufficient.
Public CLI behavior, immutable build identity and model-facing read boundaries are unchanged.
