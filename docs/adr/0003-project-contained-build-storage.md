# Keep build storage inside the project

## Status

Accepted.

## Context

A repository can provide `.lore` as a symbolic link. Following it redirects builds,
state and objects containing copies of source content into its target. Checking only
the target's owner does not establish consent: a repository can point at another
directory the same user owns (#572).

## Decision

During configuration loading, refuse `.lore` links that resolve outside the canonical
project root, regardless of ownership, with `LORE_E_PATH_ESCAPE`. Refuse dangling links
too. Allow links to existing targets inside the project. Doctor reports the refused
target in its build-directory check.

## Consequences

Repositories cannot silently select an external build-storage location through this
link. Users who deliberately placed `.lore` outside the project must remove the link
and keep build storage inside the project. Future external storage configuration
requires an explicit trust boundary rather than an ownership exception.

Real CLI tests check that refusal leaves the external target untouched. Shared core
tests cover external, dangling and contained links on supported platforms.
