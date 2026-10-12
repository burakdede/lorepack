# Source-free package import

## Status

Accepted.

## Context

A verified archive could outlive its sources but could not be consumed by Lorepack itself.
The runtime reads registered immutable builds, while archives deliberately omit mutable
project state and operational identity. Extracting arbitrary archive paths into a project
would turn a read-only content package into a source or configuration write capability.

## Decision

Add a controller-only import command. Verify a bounded private archive snapshot, stream
approved build/report/object members into private staging, and install the exact immutable
build under the project writer lock before registering it as verified. Activation stays a
separate explicit pointer operation. Refuse existing immutable builds and corrupt existing
objects. Original source members are not restored.

Empty consumers receive a minimal configuration and a new corpus/namespace binding.
Imported build IDs and locators remain unchanged; existing projects preserve their binding
and active pointer. Operational import time is not canonical content.

## Consequences

No parser, compiler, original source tree, API key or account is required to consume a
package. Source-based commands need a user-configured source root. Integrity remains
unsigned. Disk failures may leave unreferenced objects or a sealed unregistered build,
but cannot activate a partial import or overwrite the active build.
