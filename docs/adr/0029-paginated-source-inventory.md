# Expose source inventory through the shared runtime

## Status

Accepted.

## Context

Source enumeration was a local-only host callback. Models and remote callers had to guess
search terms to discover build content, while Studio loaded every artifact in one response.
A mutable active pointer can change between page requests even though builds are immutable.

## Decision

Add listSources to LoreRuntime and expose the same bounded contract over HTTP, MCP and SDK.
Supersede the earlier fixed seven-capability assumption for this read-only inventory.
Use [SQLite offset/limit pagination](https://www.sqlite.org/lang_select.html#the_limit_clause) in the actual SQLite and projected D1 catalog queries, ordered
by canonical path and artifact ID. Require an explicit build ID whenever offset is positive.
Return the selected build and runtime binding identities, a locator per artifact and an
explicit null continuation at the end. Studio pins every subsequent page to the first ID.

## Consequences

Clients can enumerate documents without retrieval guesses and use returned locators to read
that exact build. Each page costs one catalog query after acquiring its reader. New clients
must follow continuation metadata rather than assuming the first page is a full inventory.
The local inspector can still request an unpaginated catalog listing through its storage
port. Inventory remains read-only and does not add a model-facing lifecycle mutation.
