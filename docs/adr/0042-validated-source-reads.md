# Validate source reads through one handle per pass

## Status

Accepted for v0.1, issue #584.

## Context

A discovered pathname can change before fingerprinting or parsing. Following a
replacement can read an unrelated object; opening a replacement FIFO can block.
A discovery-time size check cannot bound later reads. Content equality alone
cannot establish that a file still belongs to the selected source tree.

## Decision

Record private physical containment and device/inode metadata at discovery.
Open once per fingerprint or parse pass, validate the handle before content,
read with the configured byte cap, and check read stability afterward. Keep the
existing content-hash comparison before parsing and close every handle. Reject
uncertain candidates instead of activating a partial fingerprint.

Use Node filesystem APIs. POSIX adds no-follow/nonblocking open flags. As the
[libuv filesystem contract](https://docs.libuv.org/en/v1.x/fs.html) documents,
these flags are unsupported on Windows. Windows therefore uses read-only open
and validates physical containment and the returned handle identity, type and
size before reading. Do not claim equivalent syscall-level no-follow behavior.

## Consequences

Metadata remains operational and never affects build IDs, catalog schemas or
cache identity. Ordinary stable input retains its identity. Each pass bounds
memory and file descriptors; no native dependency, helper executable or whole
corpus snapshot is added. An edit during a read can require a fresh build.
Native Windows tests must exercise file/parent replacement and size boundaries;
a POSIX filesystem FIFO fixture has no Windows equivalent and is skipped there.
