# Source selection and watch verification

Issues #587 and #588 keep discovery, watch events and the periodic reconciliation floor
consistent. [ADR0038](../adr/0038-project-root-ignore-anchoring.md) records project-root
ignore anchoring; #589 retains separate path/pattern normalization work.

## Deterministic regressions

`packages/cli/test/watch_sources.test.ts` uses real files and builds. Its Chokidar double
emits only `ready`, so directory, multiple-root and file-source edits must rebuild through
the periodic sweep while `lastEventAt` remains null. The resulting build differs and
reports clean freshness. Empty-source cases restore the first artifact after startup;
that empty snapshot must remain distinct from an uninitialized floor.

The actual ignored callback is compared with discovery for project-root rules, file
sources, directory pruning, contents negations, excluded source ancestors, pre-stat paths
and declared/real directory links (junctions on Windows). `.lore` stays excluded. The
compiler anchoring suite independently covers selected identities and cross-root
reproducibility. Exclusion samples use project-relative paths; included IDs stay relative
to their declared source.

On 16 October 2026, macOS arm64/Node24.21.0: compiler anchoring first failed nine cases
with three controls passing. The compiler correction passed all98new/existing discovery
cases. Integrating the older source-relative watcher produced14callback-policy failures
with seven controls passing. Sharing ancestor decisions and mapping event inputs to the
project root passed all119watch/discovery cases. These are scoped results; broader current
integration and native qualification remain required.

## Actual CLI and protocols

`packages/cli/test/ignore_anchoring.e2e.test.ts` builds a `sources: [docs]` fixture twice
from different absolute paths and requires identical build IDs. `/docs/private/` excludes
private content. The actual bundled CLI, HTTP and MCP must find cited public content and
return no private search hits. HTTP/MCP inventory contains only the public document; a
direct read of the excluded artifact is refused. Build, strict changed-test types, lint,
format and266compiler/init/public-read cases passed on the compiler layer before final
watcher integration. This does not establish a new desktop-client trust observation.

`packages/cli/test/dev.e2e.test.ts` keeps the same source-relative-edit scenario and persistent
MCP HTTP client across a live edit. Its fixture now includes `/docs/private/`,
`/docs/ignored/` and `/docs/drafts/**` with `!/docs/drafts/keep.md`. The included file lives
at `docs/public/p.md`; its narwhal marker and the retained draft's quokka marker must become
searchable with a new build ID, clean freshness and exact source-relative locators. Updated
ignored/private markers remain absent over HTTP and the same MCP client, without reconnecting.
The client is protocol SDK2.2.0 pinned to MCP2026-07-28. This updated live fixture passed
in the broader330-case run; that run had329passes and one separate existing `notes.bin`
no-op failure. The failed original watcher file reproduced17passes/one failure, while
its older baseline passed all18. Diagnostic observations allowed the file and saw the
expected raw rename/add path but did not establish the timing cause. Those probes were
removed. After replacing per-event branching with one precomputed logical prefix, all18
original watcher and23source-policy cases passed together, including a root-file event
eligibility control. No assertion, deadline, retry, skip or scheduling control changed.
Final complete current-source qualification remains required.

```sh
pnpm build
pnpm exec vitest run packages/compiler/test packages/cli/test/init.test.ts packages/cli/test/ignore_anchoring.e2e.test.ts packages/cli/test/watch_sources.test.ts packages/cli/test/watch.test.ts packages/cli/test/dev.e2e.test.ts
```

## Repeatable user check

Use a disposable `sources: [docs]` project with public, private and ignored Markdown files.
Add the project-root rules above, start the real `lorepack dev` binary and inspect its
Studio/HTTP/MCP connection block. Edit the public and negated draft files, and also edit
private/ignored files. Check a changed active build, clean freshness, matching HTTP/MCP
locators and no excluded markers. Keep the MCP client connected across the edit. Stop the
process before removing the fixture. POSIX SIGTERM observations do not establish Windows
graceful-handler or descendant-cleanup behavior.

On 16 October 2026, the updated real CLI user check also passed on macOS arm64/Node24.21.0.
Editing only excluded files kept the same clean build. Editing public and negated sources
activated a new clean build; HTTP and the same connected MCP client returned exact
`docs:public/p.md` and `docs:drafts/keep.md` locators. Both excluded markers stayed absent.
The connection block and normal shutdown output were inspected. This is local CLI/protocol
evidence, not desktop trust or Windows descendant-cleanup qualification.

Historical #587 proof at c91259d3 used source-root ignore semantics before ADR0038. That
manual run's `docs:private/p.md` result is retained on the issue as historical evidence;
it is not expected after this migration. Final current-source full verification and
native Linux/macOS/Windows proof are required before either issue closes.
