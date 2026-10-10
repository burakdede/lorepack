import { builtinModules } from 'node:module';

/**
 * The allowed dependency edges, as data. Architecture section 9.1.
 *
 * A new package must be added here deliberately, which is the point: the rule set is
 * reviewed in a pull request rather than discovered when something imports the wrong thing.
 */

export const PACKAGES = [
  'core',
  'parsers',
  'compiler',
  'backend-local',
  'runtime',
  'mcp',
  'cli',
  'connect-clients',
  'deploy-cloudflare',
  'sdk',
  'studio',
] as const;

export type PackageName = (typeof PACKAGES)[number];

/**
 * Where each package lives, relative to the repository root. Studio is an app rather than a
 * library, and it went unchecked for as long as the list assumed `packages/` (#617).
 */
export const PACKAGE_DIRS: Readonly<Record<PackageName, string>> = {
  core: 'packages/core',
  parsers: 'packages/parsers',
  compiler: 'packages/compiler',
  'backend-local': 'packages/backend-local',
  runtime: 'packages/runtime',
  mcp: 'packages/mcp',
  cli: 'packages/cli',
  'connect-clients': 'packages/connect-clients',
  'deploy-cloudflare': 'packages/deploy-cloudflare',
  sdk: 'packages/sdk',
  studio: 'apps/studio',
};

/** Workspace packages each package may import from. */
/** Test-only workspace packages, permitted as devDependencies anywhere. */
export const TEST_ONLY_PACKAGES: readonly string[] = ['test-support'];

export const ALLOWED_WORKSPACE_EDGES: Readonly<Record<PackageName, readonly PackageName[]>> = {
  core: [],
  parsers: ['core'],
  compiler: ['core', 'parsers'],
  'backend-local': ['core'],
  // Nothing. The runtime reaches storage through the ports in `core`, and the Worker in
  // Phase 6 supplies different ones. An edge to a backend would make "the same runtime
  // runs on D1" an intention rather than a fact, so the rule removes the possibility.
  runtime: ['core'],
  mcp: ['core', 'runtime'],
  'connect-clients': ['core'],
  // Phase 6 ships one Cloudflare package that owns both the Worker app and the deploy
  // adapter. It consumes the portable runtime and MCP layers, and it also reads sealed
  // local builds through backend-local without reaching into compiler internals.
  'deploy-cloudflare': ['core', 'backend-local', 'runtime', 'mcp'],
  sdk: [],
  // Architecture 9.1: "studio communicates only through HTTP APIs". The SDK is the HTTP
  // client, so it is the one workspace package Studio may reach.
  studio: ['sdk'],
  // parsers is reachable through compiler, but the CLI names parser versions in the
  // lockfile, so the edge is explicit rather than transitive.
  // backend-local is reachable because the CLI owns the build orchestration: it opens the
  // state store, the object store and the candidate database. The runtime reaches storage
  // through ports; the compiler never does.
  cli: [
    'core',
    'compiler',
    'parsers',
    'backend-local',
    'runtime',
    'mcp',
    'connect-clients',
    'deploy-cloudflare',
  ],
};

/**
 * External modules a package may never import, whatever the dependency graph says.
 * `core` is the strict case: it is the only package that must stay portable across
 * every runtime, so the release-candidate SQLite API and protocol churn cannot reach it.
 */
export const FORBIDDEN_EXTERNAL: Readonly<Record<string, readonly (string | RegExp)[]>> = {
  core: [
    'node:sqlite',
    /^hono/,
    /^react/,
    /^@modelcontextprotocol\//,
    /^pdfjs-dist/,
    /^mammoth/,
    /^exceljs/,
    /^csv-parse/,
    /^unified/,
    /^rehype/,
    /^remark/,
    /^wrangler/,
    /^@cloudflare\//,
    /^chokidar/,
  ],
  parsers: ['node:sqlite', /^hono/, /^react/, /^@modelcontextprotocol\//, /^@cloudflare\//],
  compiler: [/^hono/, /^react/, /^@modelcontextprotocol\//, /^@cloudflare\//],
  runtime: [/^react/, /^@modelcontextprotocol\//],
  'deploy-cloudflare': [/^react/],
  sdk: ['node:sqlite', /^hono/, /^react/, /^@modelcontextprotocol\//],
  // A browser bundle: no Node built-in, and nothing that serves, stores or parses.
  studio: [
    /^node:/,
    ...builtinModules,
    /^hono/,
    /^@modelcontextprotocol\//,
    /^@cloudflare\//,
    /^wrangler/,
    /^pdfjs-dist/,
    /^mammoth/,
    /^exceljs/,
    /^csv-parse/,
    /^chokidar/,
  ],
};

/**
 * Packages whose sources must not throw a bare Error. Every user-facing failure needs a
 * stable code, a remediation, and an exit code, which only LoreError carries.
 */
export const NO_BARE_ERROR_PACKAGES: readonly PackageName[] = [
  'core',
  'compiler',
  'runtime',
  'cli',
];
