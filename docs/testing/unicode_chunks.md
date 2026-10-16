# Unicode chunk and cache verification

Issue: #591. Decision: [ADR0041](../adr/0041-deterministic-chunk-boundaries.md).

Run `pnpm build`, then the compiler normalization/fingerprint tests and the CLI
build and `chunk_unicode.e2e.test.ts` tests. The property test retains its seeded
mixed Unicode corpus and original run count. Assert well-formed stored text,
real configured overlap, forward progress and the existing chunk size limits.

For a real warm-cache migration, build a Markdown file containing an odd ASCII
prefix followed by 6000 emoji using the previous CLI. Build it again to establish
cache reuse. Without editing its source or config, rebuild with the new CLI:
expect a cache miss, well-formed catalog chunks and a different logical build ID.
Build once more to confirm reuse resumes. Hash the previous retained build before
and after; its bytes must remain unchanged. Pack and verify the new build.

Serve the new build and request the same task through CLI export, HTTP context
and a real MCP client using the same supported `chat` profile as CLI export.
Also check that the smaller default budget reports its omission honestly. Decode each response and check well-formed text, no invented
replacement characters, the same build ID and the original source locator. Native
context delivery already preserved full source bodies before this change; this
is a delivery control, not a claim that every adapter previously corrupted text.

Record exact CLI revisions, Node/OS versions, commands and observed results in the
issue handoff. A passing parser or export control alone does not establish correct
stored chunks or migration. Native CI must cover Linux, macOS and Windows before
completion. Do not relax the original corpus, deadlines or assertions.

## Recorded local check

On 2026-10-16, macOS arm64 with Node 24.21.0, previous CLI a43613e7
produced three chunks containing U+FFFD and reused its parse on a second build.
The corrected CLI rebuilt the same unchanged source with zero reused artifacts,
produced three well-formed chunks and reused one artifact on its next build.
The previous retained build's file hashes were unchanged; the new packed archive
verified. CLI export, HTTP and a real MCP client with the `chat` profile all
returned the corrected build ID and `emoji.md` line 3. The smaller default HTTP/
MCP budget omitted that large native unit with the budget reason, as intended.

The first manual delivery check incorrectly expected the default budget to fit
this large unit. Its failure was retained and the follow-up checked both the
honest default omission and positive delivery with the existing export profile.
No product limit or existing test control changed.
