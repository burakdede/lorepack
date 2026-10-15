# Record actual activation transitions

## Status

Accepted. Verified with real local SQLite, the projected adapter, local workerd D1,
the actual CLI binary, and served Studio browser flows on 2026-10-15.

## Context

Creation and verification timestamps do not establish which build was active before
the current one. Local CLI, Studio and remote bare rollback each make a different guess.
Local pointer updates are transactional; remote activation uses a guarded D1 statement,
then records separate projection metadata. The command-backed D1 adapter cannot hold an
arbitrary transaction across separate command invocations.

## Decision

Record operational pointer transitions with an AFTER UPDATE trigger in each backend.
For transitions to a build, pointer and event succeed together. A nullable empty pointer
remains valid for retained-build reads and is not labelled as a build activation.
Reactivation from that state records no previous active build. Use monotonic generation for ordering and database
UTC time for observation, outside immutable build identity. Same-ID writes create no
transition; preserve each backend's existing generation behavior. History has no foreign
key to retained builds, so pruning cannot rewrite the activation facts.

Legacy migration records only an explicitly labelled observation of the active pointer.
It never invents an earlier transition or activation time. Install the remote trigger
before recording this baseline, because remote migration statements execute separately.
An intervening real transition makes a baseline unnecessary. Migration retry must not
overwrite either fact.

Bare rollback selects the actual predecessor from a consistent pointer/history snapshot.
The selection must participate in the local project lock or remote final CAS. A missing,
unknown or pruned predecessor is an explicit refusal. Explicit retained-ID selection
remains available, including supported legacy remote projections.

The developer history endpoint supplies Studio's target and unavailable reason. Studio
must not duplicate a timestamp-based selector. Display bounded history with its scope
and truncation labelled; displayed samples do not determine the rollback target.

## Consequences

Old state remains honest about unknown history. An event-write failure prevents the
pointer update, while a later remote metadata-write failure retains the transition that
actually occurred. Activation history never changes a build ID or adds a model-facing
mutation. Local migration, projected adapter, workerd, CLI and browser regressions enforce
these boundaries. Native qualification remains a release requirement.

References: [SQLite triggers](https://www.sqlite.org/lang_createtrigger.html),
[SQLite UTC date functions](https://www.sqlite.org/lang_datefunc.html),
[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
