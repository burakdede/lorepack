/**
 * Runtime preflight. Imported before anything else so an unsupported Node version
 * fails with one actionable line instead of a confusing downstream stack trace.
 *
 * The floor is not version hygiene. Node 24.19.0 is the first 24.x release that bundles
 * SQLite 3.53.2 or newer (it ships 3.53.3). Earlier SQLite releases carry FTS5
 * memory-corruption bugs (CVE-2026-11822, CVE-2026-11824) that a crafted database
 * triggers through an FTS5 MATCH, and an FTS5 MATCH over `context.sqlite` is the whole
 * retrieval path. The older reasons sit below that floor: node:sqlite reached
 * release-candidate stability and gained per-connection limits in 24.15, setAuthorizer in
 * 24.10 and defensive-by-default in 24.14.
 *
 * The Node version cannot prove the SQLite version, because a distribution can link Node
 * against a shared system SQLite. So the SQLite version is checked separately, by the
 * caller that is allowed to open `node:sqlite` (core imports no database code).
 */

export const SUPPORTED_NODE_RANGE = '>=24.19.0 <25' as const;
export const MINIMUM_NODE = { major: 24, minor: 19, patch: 0 } as const;
export const MAXIMUM_NODE_MAJOR = 24 as const;

/** The first SQLite release with the fixes for CVE-2026-11822 and CVE-2026-11824. */
export const MINIMUM_SQLITE_VERSION = '3.53.2' as const;
const MINIMUM_SQLITE = { major: 3, minor: 53, patch: 2 } as const;

const SQLITE_ADVISORIES = [
  'https://osv.dev/vulnerability/CVE-2026-11822',
  'https://osv.dev/vulnerability/CVE-2026-11824',
] as const;

export interface EngineCheckResult {
  readonly supported: boolean;
  readonly detected: string;
  readonly reason?: 'too-old' | 'too-new' | 'unparseable';
  /** The stable error code a script can branch on. Present whenever `supported` is false. */
  readonly code?: 'LORE_E_UNSUPPORTED_NODE' | 'LORE_E_UNSUPPORTED_SQLITE';
  readonly message?: string;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseNodeVersion(raw: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compare(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function upgradeInstruction(): string {
  return [
    'Install Node 24.19.0 or newer (below Node 25):',
    '  nvm install 24 && nvm use 24',
    '  # or: fnm use 24 | mise use node@24 | volta install node@24',
    'Official builds: https://nodejs.org/en/download',
  ].join('\n');
}

export function checkNodeVersion(detected: string = process.versions.node): EngineCheckResult {
  const version = parseNodeVersion(detected);
  if (!version) {
    return {
      supported: false,
      detected,
      reason: 'unparseable',
      code: 'LORE_E_UNSUPPORTED_NODE',
      message: `Lorepack could not parse the Node version "${detected}".\nSupported range: ${SUPPORTED_NODE_RANGE}.\n\n${upgradeInstruction()}`,
    };
  }

  if (compare(version, MINIMUM_NODE) < 0) {
    return {
      supported: false,
      detected,
      reason: 'too-old',
      code: 'LORE_E_UNSUPPORTED_NODE',
      message: `Lorepack requires Node ${SUPPORTED_NODE_RANGE}, but this is Node ${detected}.\nNode 24.19.0 is the first release that bundles SQLite ${MINIMUM_SQLITE_VERSION} or newer, which fixes FTS5 memory corruption (CVE-2026-11822, CVE-2026-11824) reachable from every search.\n\n${upgradeInstruction()}`,
    };
  }

  if (version.major > MAXIMUM_NODE_MAJOR) {
    return {
      supported: false,
      detected,
      reason: 'too-new',
      code: 'LORE_E_UNSUPPORTED_NODE',
      message: `Lorepack supports Node ${SUPPORTED_NODE_RANGE}, but this is Node ${detected}.\nNode ${version.major} is untested: node:sqlite is a release candidate and its API may differ.\n\n${upgradeInstruction()}`,
    };
  }

  return { supported: true, detected };
}

function sqliteRemediation(): string {
  return [
    `Install an official Node build, which bundles SQLite ${MINIMUM_SQLITE_VERSION} or newer from Node 24.19.0:`,
    '  https://nodejs.org/en/download',
    '  or: nvm install 24 | fnm use 24 | mise use node@24',
    'A Node linked against a shared system SQLite carries that system SQLite instead.',
    `Advisories: ${SQLITE_ADVISORIES.join(' ')}`,
    'See docs/compatibility/sqlite-fts5.md',
  ].join('\n');
}

/**
 * Checks the SQLite version `node:sqlite` reports, as returned by `SELECT sqlite_version()`.
 *
 * Takes the string rather than querying, so it stays a pure function in a module that imports
 * no database code, and so a test can hand it any version.
 */
export function checkSqliteVersion(detected: string): EngineCheckResult {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(detected.trim());
  if (!match) {
    return {
      supported: false,
      detected,
      reason: 'unparseable',
      code: 'LORE_E_UNSUPPORTED_SQLITE',
      message: `Lorepack could not parse the SQLite version "${detected}", so it cannot confirm the FTS5 fixes in ${MINIMUM_SQLITE_VERSION}.\n\n${sqliteRemediation()}`,
    };
  }

  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  if (compare(version, MINIMUM_SQLITE) < 0) {
    return {
      supported: false,
      detected,
      reason: 'too-old',
      code: 'LORE_E_UNSUPPORTED_SQLITE',
      message: `This Node uses SQLite ${detected}, but Lorepack requires SQLite ${MINIMUM_SQLITE_VERSION} or newer.\nEarlier releases carry FTS5 memory corruption (CVE-2026-11822, CVE-2026-11824) that a crafted build database can trigger through search.\n\n${sqliteRemediation()}`,
    };
  }

  return { supported: true, detected };
}

function refuse(result: EngineCheckResult, what: string, env: NodeJS.ProcessEnv): void {
  if (result.supported) return;

  if (env.LORE_SKIP_ENGINE_CHECK === '1') {
    process.stderr.write(
      `warning: running on an unsupported ${what} (${result.detected}) because LORE_SKIP_ENGINE_CHECK=1.\nExpect failures in SQLite, search, and build determinism.\n`,
    );
    return;
  }

  process.stderr.write(`${result.message}\n  code: ${result.code}\n`);
  process.exit(3);
}

/** Exits the process when the runtime is unsupported. Called from the CLI entry point. */
export function assertSupportedNode(
  detected: string = process.versions.node,
  env: NodeJS.ProcessEnv = process.env,
): void {
  refuse(checkNodeVersion(detected), 'Node', env);
}

/**
 * Exits the process when the linked SQLite predates the FTS5 fixes. Called from the CLI entry
 * point once the Node check has passed, with the version `node:sqlite` reports.
 */
export function assertSupportedSqlite(
  detected: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  refuse(checkSqliteVersion(detected), 'SQLite', env);
}
