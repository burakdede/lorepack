# Bound pattern input before matcher compilation

## Status

Accepted.

## Context

Issue #590 records a short repeated-star pattern that makes ordinary source
selection spend excessive time in the matcher. Ignore selection, watcher filtering
and declared precedence use separate compilation paths. A length limit alone
cannot reject that short pattern. Architecture sections 12.7 and 12.11 require
consistent rule decisions and reliable reconciliation.

## Decision

Share one pure admission policy in core's configuration schema: no more than
512 UTF-16 code units and four literal stars per forward-slash segment. Count
stars conservatively without parsing a second glob grammar. Validate ignore
patterns after their existing portable separator conversion and declared rules
without changing escape semantics. Reject with a typed configuration error before
compilation, naming the ignore line or rule field. Validate direct compiler calls
and unused supersession patterns too. Keep the pinned matcher dependency.

## Consequences

Existing admitted patterns retain their meaning, precedence and build identity.
Some elaborate patterns, including escaped/bracketed literal stars, must be split
into simpler rules. New invalid input cannot replace the selected immutable build.
The bounded scan adds no dependency, plugin or runtime service. It is an admission
limit rather than a proof of constant matching time for every admitted pattern.
