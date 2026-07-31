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
] as const;

export type PackageName = (typeof PACKAGES)[number];

/** Workspace packages each package may import from. */
/** Test-only workspace packages, permitted as devDependencies anywhere. */
export const TEST_ONLY_PACKAGES: readonly string[] = ['test-support'];

export const ALLOWED_WORKSPACE_EDGES: Readonly<Record<PackageName, readonly PackageName[]>> = {
  core: [],
  parsers: ['core'],
  compiler: ['core', 'parsers'],
  'backend-local': ['core'],
  runtime: ['core', 'backend-local'],
  mcp: ['core', 'runtime'],
  'connect-clients': ['core'],
  'deploy-cloudflare': ['core'],
  sdk: [],
  cli: ['core', 'compiler', 'runtime', 'mcp', 'connect-clients', 'deploy-cloudflare'],
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
  'deploy-cloudflare': ['node:sqlite', /^react/],
  sdk: ['node:sqlite', /^hono/, /^react/, /^@modelcontextprotocol\//],
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
