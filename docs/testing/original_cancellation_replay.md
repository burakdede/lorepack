# Original Windows cancellation replay

This experimental branch references issue #764. Never merge it into the release
source. Its manual CI run checks out original failing source
`2e41c031c6de642aa0100493b63c7d53ecd71b5b` into a separate directory. The
normal pull-request checks still test the current branch.

The preparation script verifies the original commit, tree, clean checkout and
fixed patch hash before applying only the existing dev test diagnostics and
passive helper. It verifies both resulting file hashes and changed paths.
Production, dependencies, configuration and the original workflow stay intact.
The patch is staged so the original tracked-source check can inspect the helper.

The Windows job copies the original verification steps and their order. It keeps
the full test selection, 2400-file fixture, signals, assertions, deadlines and
scheduling. Existing caller buffers supply live output. Previously unconsumed
pipes are read only after failure. A passing replay does not establish the
original intermittent failure's cause or satisfy issue #764 by itself.

After local qualification and review, dispatch the existing CI workflow once at
this experiment branch. The manual run selects only the historical evidence job.
Retain its real result and full job log, plus the always-uploaded source bindings,
patch and test reports. Do not automatically retry an unchanged failed run.
Investigate its actual phase evidence before choosing a product correction on
current main. Final integrated local and native qualification remain required.
