# Retained operations do not require source validation

## Status

Accepted, 2026-10-12. Implements #694.

## Context

Architecture section 18.4 makes rollback a pointer change over retained evidence.
Loading configuration previously resolved live sources before every command, so removing
the source directory prevented rollback and reads even when the retained build was healthy.
Making source validation globally optional would also let compilation use unchecked roots.

## Decision

Split `ProjectConfig` from `LoadedConfig`. The former validates project configuration and
local state containment; the latter additionally validates source roots and supplies
effective build inputs. Retained operations accept `ProjectConfig`. Compilation accepts
only `LoadedConfig`. Source freshness validation occurs separately from retained reads.

Retain target manifest, catalog and object-presence preflight before activation. Source
configuration failures produce unknown query freshness; they cannot invalidate retained
evidence. Corrupt state and build failures remain errors.

## Consequences

Recovery, inspection and serving survive source and parser-cache removal. Build, planning
and explicit current-source workflows retain strict validation. Project configuration and
retained build data are still required. Packing with original files explicitly enabled
still requires those originals. Preflight does not claim full logical hash verification.
