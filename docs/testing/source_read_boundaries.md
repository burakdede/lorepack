# Source-read boundary verification

Issue [#584](https://github.com/burakdede/lorepack/issues/584) covers source
replacement and growth after discovery. Native handle behavior requires the
three-platform checks; a local pass alone is not Windows proof.

Run the real filesystem regressions after building:

```sh
pnpm build
pnpm exec vitest run packages/compiler/test/source_read_boundaries.test.ts packages/cli/test/source_read_boundaries.test.ts packages/cli/test/build.test.ts
```

The compiler cases replace a leaf with an outside link, replace a parent directory
with an outside junction, replace a same-content inode, grow past the configured
cap, and edit within the cap. They check actual bytes and typed diagnostics.
A separate POSIX child replaces the source with a FIFO; an eight-second watchdog
contains the original blocking-open failure. Only that fixture is skipped on
Windows, where POSIX filesystem FIFOs are unavailable.

The CLI service integration uses actual SQLite and project files. Both warm and
cold cache runs replace a parent at the real fingerprinting and parsing stage
boundaries. The build must fail with `LORE_E_STALE_SOURCES`. The selected build,
manifest bytes and catalog hash must stay unchanged. A separate freshness case
must refuse certainty about a changed source.

For the interactive surfaces, use a project with one Markdown source:

1. Build and record its build ID. Read it through CLI, HTTP and an MCP client.
2. Confirm the same source locator and build ID on each read surface and Studio.
3. Run the regressions above to exercise deterministic race boundaries; ordinary
   manual edits cannot reliably reproduce a discovery-to-read race.
4. Inspect the previous build after refusal and verify its manifest/catalog hashes.
5. Restore the source, build again and check that all read surfaces converge.

Record exact versions, platform and results when executing this checklist. Do not
call browser DOM checks proof of Windows handle behavior or native accessibility.
