# Source-relative watch verification

Issue #587 restores agreement between discovery, watch-event filtering and the periodic
reconciliation floor. It retains the separate #588 ignore-anchoring decision and #589 path
normalization work.

## Automated cases

`packages/cli/test/watch_sources.test.ts` uses real temporary files and builds. Its Chokidar
double emits only `ready`; it cannot emit a content-change event. Directory, multiple-root
and individual-file edits must therefore rebuild through the periodic sweep, while
`lastEventAt` stays null. Each resulting active build differs and reports clean freshness.

The actual ignored callback is compared with discovery for source-relative anchored rules,
file roots, directory pruning and negations. Further cases cover traversable source ancestors,
unknown stat information, unconfigured files and declared/real paths through a directory link
(junction on Windows). `.lore` stays excluded.

`packages/cli/test/dev.e2e.test.ts` drives the real built binary. A `sources: [docs]` project
contains `/docs/private/`, `/ignored/` and `/drafts/**` with `!/drafts/keep.md`. These patterns
retain current source-relative semantics: the first does not exclude `docs/private/p.md`.
The updated included and negated files become searchable over HTTP with the new build ID,
clean freshness and exact locators; updated ignored content stays absent. A long-lived
MCP HTTP client connects before the edit and reads again afterward without reconnecting.
Verified 2026-10-16 with `@modelcontextprotocol/client`2.2.0, pinned to MCP2026-07-28:
the same client observes the new build, clean freshness and exact locator. This is the
protocol SDK check, not a new desktop-client trust verification.

```sh
pnpm build
pnpm exec vitest run packages/cli/test/watch_sources.test.ts packages/cli/test/watch.test.ts packages/cli/test/dev.e2e.test.ts
```

## Actual local CLI check

Verified 2026-10-16 on macOS arm64, Node 24.21.0, the local 0.1.0 CLI build. This verifies the
local CLI and HTTP runtime, not a new external MCP client version or trust dialog.

- Started the real built `dev` binary against an isolated project with `sources: [docs]`,
  `/docs/private/` and `/ignored/`. The connection block named Studio, HTTP, MCP HTTP and
  MCP stdio; the terminal said `Watching for changes. Press Ctrl-C to stop.`
- Changed `docs/private/p.md` to contain `Narwhal calibration is reviewed.` and changed
  `docs/ignored/p.md` to contain a separate `Hiddenorca` marker. The first remains included
  under the current source-relative rules; the second remains excluded.
- The active build changed. `POST /v1/search` with `{"query":"narwhal"}` returned
  `sourceState: "clean"`, locator artifact `docs:private/p.md`, path `private/p.md`, line 3.
  Searching `hiddenorca` returned zero hits. Both responses came from the active immutable
  build, without a server restart.
- SIGTERM on this POSIX run drained requests and stopped the supervisor. This does not
  establish Windows graceful-signal or descendant-cleanup behavior.

The new regression run failed 11 cases with one control passing before production edits.
All 14 new cases and the complete existing watcher/dev files then passed together:56 tests.
Full current-source verification and native Linux/macOS/Windows proof remain required
before issue closure. Do not treat the local check as final release qualification.
