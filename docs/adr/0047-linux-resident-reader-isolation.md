# Linux resident reader isolation

## Status

Accepted design for #801. Native qualification remains required.

## Context

The [#805 diagnostic experiment](https://github.com/burakdede/lorepack/pull/805)
observed compiler-parent event-loop gaps of about 488 ms and 449 ms alongside a
native Linux procfs read abort at about 450 ms. An idle actual reader completed in
about 1 ms; deliberately blocking its parent for 500 ms reproduced an abort. These
observations establish a mechanism, not a shared cause for every historical failure.

An unpublished design moved the parser child into a supervisor worker. Its actual
blocked-parser regression left that process alive after abrupt worker termination.
Worker exit hooks and parser IPC disconnect cannot guarantee cleanup while parser
JavaScript is blocked. That design and its failed receipts are retained under #801;
it is not the shipping architecture.

## Decision

Keep the actual parser `ChildProcess`, public host and every signal on their
existing owner event loop. Move only continuous Linux procfs RSS reading into a
built-in Node worker. This worker owns no descendants, never signals a PID and
has only read permission in the privacy proof. Parsing remains in the separate
permission-constrained child with unchanged grants and heap/resource controls.
macOS and Windows retain their original readers.

Retain the same procfs measurement, 250 ms native read deadline and serialized
100 ms interval after each completed read, including between reusable-child jobs.
Each child gets a fresh generation and shared state. The reader publishes sticky
terminal status before typed detail; the host checks it before accepting a parser
result or classifying exit. A terminal flag without its detail cannot authorize
success. Unexpected reader-worker failure fails closed through the host's owned
child handle. Stale generations cannot affect replacement children.

The owner captures the actual child PID and procfs start time in the same JavaScript
turn as its fork. The sampler checks that birth identity before and after reading
RSS within one shared 250 ms native-read budget. PID reuse cannot authorize a report
for a replacement process. The sampler still has no signaling capability.

Stop and join the reader during child close, cancellation and host shutdown.
There is no raw numeric-PID kill fallback or idle monitoring pause. The reader
entry is a real compiled file and explicit CLI bundle entry; the installed package
must resolve it without source files or workspace aliases.

## Consequences

Compiler-parent transforms cannot block the reader's JavaScript loop. The host
still applies enforcement when its own loop runs, as in the original direct-host
implementation. This is a sampled guard, not a kernel quota or a promise to kill
during arbitrary compiler-parent blocking. The reader shares libuv's pool and OS
scheduling constraints, so genuine native read failures still fail closed.

The worker adds runtime overhead and an installed helper. Native qualification
must retain original workload/resource/performance criteria, queued-result and
exit ordering, real reader failure, replacement, cancellation and process cleanup.
The original Windows reporting/startup failures remain independently unresolved;
this Linux design does not establish their cause or correction.
