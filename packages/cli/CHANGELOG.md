# @lorepack/cli

## 0.1.0-alpha.0

### Minor Changes

- b04cf0e: Lore Studio is rebuilt as a developer inspector. A sidebar names the active build and its
  source freshness on every route, a Cmd/Ctrl-K palette jumps to any route, source or table,
  and light and dark themes follow the system unless a reader picks one. Every route keeps its
  data, provenance and confirmations; the Playground now draws the token budget to scale.
- 0cdba12: Lore Studio is now a launchpad for using the build. Overview lists the MCP and HTTP endpoints
  and a `lore connect` command for each installed client; every Playground run, search and SQL
  query can be copied as the equivalent `lore` command, `curl` call or MCP tool call; and every
  citation opens the stored text of its source with the cited lines marked.

### Patch Changes

- cf8172c: Add the v0.1 release automation gate: pull requests now require a Changesets entry or an
  explicit no-release marker, and the manual release workflow dry-runs versioning, SBOM
  generation, package tarball creation and example archive creation before any publish-side
  effect.
- 9582569: Lore Studio's Versions history no longer breaks a row's rules at 1280px, its deployment column
  gives way on narrow windows instead of sliding under the row actions, and paths in a build diff
  no longer break mid-word.
- 0cdba12: Fix Lore Studio's Overview crashing with `Cannot read properties of undefined (reading 'map')`
  after visiting Sources. A route that fails to render now shows the error inside Studio, with
  the sidebar still usable, instead of replacing the whole app.
- 35d1dc4: Table queries now pass a shared statement guard on every backend before they run. It admits only
  the requested table, common table expressions over it and subqueries, so a query can neither read
  nor detect another table. The Cloudflare Worker additionally refuses recursive common table
  expressions, table-valued JSON functions, aggregates used as windows, and joins whose row product
  exceeds a bound, because D1 cannot be interrupted before its own time limit.
- Updated dependencies [cb7ea8a]
- Updated dependencies [f899e7a]
- Updated dependencies [e00503c]
- Updated dependencies [c97256d]
- Updated dependencies [6976d0b]
  - @lorepack/mcp@0.1.0
  - @lorepack/runtime@0.1.0
  - @lorepack/core@0.1.0
  - @lorepack/compiler@0.1.0
  - @lorepack/parsers@0.1.0
  - @lorepack/connect-clients@0.1.0
  - @lorepack/deploy-cloudflare@0.1.0
  - @lorepack/backend-local@0.1.0
