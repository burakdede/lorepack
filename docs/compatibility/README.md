# Compatibility

This matrix is the support contract for v0.1 unless a later phase narrows it through a tracked
issue. Performance numbers below are linked to committed measurements and are not release-gate
claims unless the linked doc says so.

## Platform matrix

| Area | Supported | Verification |
|---|---|---|
| Node.js | `>=24.15 <25`; CI pins 24.18.1 | [`package.json`](../../package.json), [CI](../architecture/ci.md) |
| Package manager | pnpm 11.18.0 | [`package.json`](../../package.json) |
| macOS | supported on `macos-latest` and local Darwin arm64 | CI verify matrix, local shell on 2026-08-13 |
| Linux | supported on `ubuntu-latest` | CI verify matrix |
| Windows | supported on `windows-latest` | CI verify matrix, [`windows.md`](windows.md) |
| SQLite FTS5 | required | [`sqlite-fts5.md`](sqlite-fts5.md), `pnpm probe:fts5` |

## Client matrix

| Client or target | Status | Verified version and date | Guide |
|---|---|---|---|
| Claude Code | supported | Claude Code 2.1.220 on 2026-08-03; local version smoke 2.1.228 on 2026-08-13 | [`../integrations/claude-code.md`](../integrations/claude-code.md) |
| Codex | supported | `codex-cli` 0.146.1 on 2026-08-05; local version smoke 0.147.0 on 2026-08-13 | [`../integrations/codex.md`](../integrations/codex.md) |
| VS Code | supported | VS Code 1.132.0 on 2026-08-05 | [`../integrations/vscode.md`](../integrations/vscode.md) |
| Generic MCP stdio clients | supported when they can launch a command with argument array | MCP protocol 2026-07-28, server package 2.0.0 on 2026-08-03 | [`../integrations/mcp.md`](../integrations/mcp.md) |
| Cloudflare target | supported for the Phase 6 projection path | Wrangler 4.119.0 package on 2026-08-13 | [`../integrations/cloudflare-target-setup.md`](../integrations/cloudflare-target-setup.md) |

## Scale envelope

| Measurement | Scope | Result | Evidence |
|---|---|---:|---|
| Full build, 60 documents of 10 pages | development-machine benchmark | 836 ms | [`benchmarks/phase-1-dev-machine.json`](../../benchmarks/phase-1-dev-machine.json), [`build-orchestration.md`](../architecture/build-orchestration.md#measured-performance) |
| Incremental rebuild after editing one document | development-machine benchmark | 139 ms | [`benchmarks/phase-1-dev-machine.json`](../../benchmarks/phase-1-dev-machine.json) |
| Warm search p95 | development-machine benchmark | 2.61 ms | [`benchmarks/phase-1-dev-machine.json`](../../benchmarks/phase-1-dev-machine.json) |
| Fingerprint at 2,500 files | envelope benchmark | 916 ms p95 | [`benchmarks/envelope/reference-2026-08-05.json`](../../benchmarks/envelope/reference-2026-08-05.json) |
| Single-document incremental rebuild at 2,500 files | envelope benchmark | 5,632 ms p95, reported only | [`benchmarks/envelope/reference-2026-08-05.json`](../../benchmarks/envelope/reference-2026-08-05.json), see `#245` decision in [`docs/architecture/build-orchestration.md`](../architecture/build-orchestration.md) |
| Byte envelope, 2,500 files and 1.005 GiB | envelope benchmark | see committed run | [`benchmarks/envelope/byte-envelope-2026-08-14.json`](../../benchmarks/envelope/byte-envelope-2026-08-14.json), measured on a Darwin arm64 development machine and not a reference gate |
| Retrieval at Phase 2 envelope | retrieval benchmark | see committed run | [`benchmarks/retrieval/phase-2-envelope-dev-machine.json`](../../benchmarks/retrieval/phase-2-envelope-dev-machine.json) |
| Cloudflare projection concurrency | remote projection benchmark | see committed run | [`benchmarks/cloudflare/projection-concurrency-2026-08-09.json`](../../benchmarks/cloudflare/projection-concurrency-2026-08-09.json) |

Reference-machine release gates are owned by issue `#101`. Do not turn the development-machine
numbers into product claims.

## Target capability matrix

| Capability | Local build runtime | `lore serve` | `lore mcp` | Cloudflare projection |
|---|---|---|---|---|
| `describeBuild` | yes | REST and HTTP MCP | stdio MCP | yes |
| `search` with source locators | yes | REST and HTTP MCP | stdio MCP | yes |
| `contextForTask` | yes | REST and HTTP MCP | stdio MCP | yes |
| `readSource` | yes | REST and HTTP MCP | stdio MCP | yes, body in R2 |
| `listTables`, `describeTable`, `queryTable` | yes | REST and HTTP MCP | stdio MCP | yes |
| build history diff | yes | local host only | local host only | unavailable |
| activate, rollback, pack | local CLI and loopback Studio only | local host only | no | deploy control plane only |
| build or deploy from model-facing tools | no | no | no | no |

## Cloudflare free-tier constraints

Cloudflare's D1 limits page currently lists a maximum D1 database size of 500 MB on Workers
Free and 10 GB on Workers Paid, and D1 queries per Worker invocation of 50 on Free and 1,000 on
Paid: <https://developers.cloudflare.com/d1/platform/limits/>.

Lorepack's Phase 6 Worker read paths are measured in
[`serving.md#worker-d1-query-budget`](../architecture/serving.md#worker-d1-query-budget) and
stay below 50 D1 queries per runtime request. Larger projected builds may still hit Free-plan
storage before they hit the per-request query ceiling.
