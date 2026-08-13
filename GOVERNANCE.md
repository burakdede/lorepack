# Governance

Lorepack is pre-v0.1. Governance is intentionally small because the project is still
finding its release shape.

## Maintainer

Burak Dede is the maintainer and final decision-maker for v0.1. The maintainer owns scope,
release timing, backlog ordering, branch protection and acceptance of contributions.

## Decision Making

Design decisions are made in GitHub issues and pull requests. The backlog issue is the
memory for a task, and session handoffs on that issue are authoritative when they conflict
with older assumptions in the issue body.

Maintainers decide by written rationale, not by vote. A decision should state the invariant
or measured result it protects. If a decision closes off an alternative, record why in the
issue, PR or architecture docs.

## Release Authority

Only maintainers publish packages, create releases, change branch protection, rotate
secrets, or merge release PRs. Release automation and provenance are tracked separately in
the Phase 7 release tickets.

## Contributor Path

Contributors work through issues and pull requests. A contributor can earn broader review
trust by repeatedly landing small, verified changes, but write access is not required to
contribute.

## Conflict Resolution

Disagreement is resolved against the project invariants in `AGENTS.md`, the architecture
spec, measured evidence and the phase backlog. If a proposed change makes Lorepack a better
search engine but a worse versioned context build system, it is out of scope for v0.1.
