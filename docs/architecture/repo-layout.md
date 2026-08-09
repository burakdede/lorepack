# Repository layout

One repository, ten publishable packages, one app. The layout mirrors architecture
section 9 exactly, and the dependency direction in section 9.1 is enforced by a test
rather than by convention (issue #11).

```text
packages/
  core/               domain types, identifiers, rules, build identity
  parsers/            built-in format adapters
  compiler/           deterministic pipeline and validation
  backend-local/      node:sqlite and filesystem adapters
  runtime/            portable context capabilities and HTTP routes
  mcp/                MCP tools, resources, transports
  cli/                the lore executable
  connect-clients/    AI client detection and configuration
  deploy-cloudflare/  Cloudflare plan, apply, verify, activate
  sdk/                typed HTTP client
apps/
  studio/             React and Vite inspector
```

## Allowed dependency edges

```text
core       <- parsers <- compiler <- cli
core       <- backend-local <- runtime <- mcp
runtime    <- cli
core       <- connect-clients <- cli
core       <- backend-local <- deploy-cloudflare <- cli
runtime    <- mcp <- deploy-cloudflare
sdk        <- studio (over HTTP only)
```

`core` imports no parser, database, MCP, UI, or Cloudflare code. That constraint is what
keeps the release-candidate `node:sqlite` API and future MCP protocol churn contained to
one package each.

Phase 6 deliberately keeps the Cloudflare Worker app and the Cloudflare deploy adapter in one
package. That package depends on the portable runtime and MCP layers for the public read
surface, and on `backend-local` plus `node:sqlite` to read sealed local builds during plan,
projection, archive, and verification steps. The boundary it still may not cross is compiler
internals.

## Why no build orchestrator

Architecture section 8.1 is explicit: do not add Turborepo, Nx, Bazel, or a remote cache
until repository timings demonstrate the need. TypeScript project references already give
incremental, dependency-ordered builds through `tsc -b`. Revisit only with a measurement.

## Toolchain

| Concern | Tool | Why |
|---|---|---|
| Package manager | pnpm workspaces | Strict `node_modules` layout surfaces undeclared dependencies, which is what makes the boundary rules real |
| Format and lint | Biome | One binary, no plugin drift between formatter and linter |
| Tests | Vitest | Same runner for Node packages and the Vite-based Studio |
| Types and build | TypeScript project references | Dependency-ordered incremental builds without an orchestrator |
| Versioning | Changesets | Per-package changelogs across ten publishable packages |
| Node version | `.node-version` and `mise.toml` | Read by mise, fnm, nvm, volta, and `actions/setup-node` |

## Commands

```bash
pnpm install
pnpm build           # tsc -b, dependency ordered
pnpm typecheck       # tsc -b (composite projects cannot use --noEmit)
pnpm lint            # biome check
pnpm format:check
pnpm test            # vitest run
pnpm check:no-native # no native add-ons or install scripts in published dependencies
pnpm check:no-em-dash
pnpm verify          # everything above, the pre-PR gate
```
