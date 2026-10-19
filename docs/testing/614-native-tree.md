# Native dependency gate traversal

Issue [#614](https://github.com/burakdede/lorepack/issues/614) closes a dependency gate
bypass: a package can hide `package.json` behind its exports map while still shipping
native files or install scripts. The gate reads manifests through physical ancestor
`node_modules` directories instead of resolving an exported module. Real paths identify
visited packages, including pnpm symlinks and dependency cycles.

The published closure includes dependencies, optional dependencies and required peers.
An absent optional peer is permitted; an installed optional peer is inspected. Other
unresolved edges fail closed. Contributor-only development dependencies remain outside
this closure. The checks cover banned dependency declarations, installed banned packages,
install hooks, `gypfile`, root `binding.gyp` and nested `.node` files. Nested
`node_modules` directories are traversed through manifest edges rather than scanned as
unrelated package files.

The sole removed-edge exception is an absent optional `pdfjs-dist -> @napi-rs/canvas`
edge when `pnpm-workspace.yaml` explicitly overrides `@napi-rs/canvas` to `-`. The gate
reads the YAML setting with the CLI's existing YAML dependency. An installed canvas
package still fails, and another package declaring that dependency gets no exemption.
The bundled npm installation gate remains separately responsible for verifying that this
workspace removal reaches the published artifact.

Verified locally on macOS, 2026-10-19, Node 24.21.0 and pnpm 11.18.0:

- `pnpm install --frozen-lockfile --ignore-scripts`: passed.
- Before the production change, `pnpm exec vitest run
  tools/arch/test/check-no-native.test.ts`: 10 failed, 7 passed. Both original
  counterexamples failed their assertions because the gate incorrectly returned no
  problems. The original four cases remained passing.
- After the change, the same focused command: all 18 tests passed. Coverage also includes
  required and optional peers, missing edges, nested scoped packages, physical symlink
  cycles, explicit override limits and packages named after Node builtins.
- `pnpm check:no-native`: passed against the actual frozen workspace dependency tree.
  An intermediate directory lookup using `require.resolve.paths` incorrectly treated
  the declared `string_decoder` package as a builtin. Direct ancestor lookup fixes this
  and the dedicated regression protects it.
- `pnpm exec biome check scripts/check-no-native.mjs
  tools/arch/test/check-no-native.test.ts`: passed, including formatting.
- `pnpm typecheck`: passed.
- `pnpm exec tsc --ignoreConfig --noEmit --strict --target es2024 --module nodenext
  --moduleResolution nodenext --types node --skipLibCheck --allowJs
  tools/arch/test/check-no-native.test.ts`: passed.

Full architecture tests, the full application suite and native Windows/Linux qualification
have not run in this session. Cross-platform CI must qualify the final PR before merge.
