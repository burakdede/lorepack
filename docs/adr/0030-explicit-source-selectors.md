# Preserve source selector namespaces

## Status

Accepted.

## Context

An artifact ID can equal another document's canonical path. Collapsing both request fields
into `id = ? OR relative_path = ? LIMIT 1` returned different documents on the local and
projected adapters. Duplicate relative paths across distinct source roots also selected an
arbitrary row. CLI inspection mixed display paths, relative paths and IDs in one query.

## Decision

Require an explicit ID/path selector at the catalog port. Preserve the runtime request's
existing artifact-ID precedence and use only the selected column. Path lookups fetch at
most two matches and refuse ambiguity with a typed, bounded error. Namespace/project/build
binding remains part of each adapter's query.

CLI inspection gives its advertised project-relative display path priority, followed by
an unambiguous relative path and existing unambiguous ID references. Ambiguity is an error,
not a ranking decision. No wire field, stored schema, immutable build identity or model-facing
mutation capability changes.

## Consequences

Every catalog adapter must preserve the caller's selector. Returned locators can be read
without their IDs being mistaken for filenames. Shared portable archive cases cover both
namespace collisions, duplicate paths and transport readback on every OS. Existing callers
placing a path in the artifact-ID field must use the path field or the real artifact ID.
