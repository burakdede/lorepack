/**
 * Runtime preflight. Imported before anything else so an unsupported Node version
 * fails with one actionable line instead of a confusing downstream stack trace.
 *
 * The floor is not version hygiene. Node 24.15 is the first release where:
 *   - node:sqlite reached release-candidate stability,
 *   - per-connection SQLite limits (db.limits) exist, required by the SQL safety contract.
 * setAuthorizer (24.10) and defensive-by-default (24.14) also sit below it.
 */

export const SUPPORTED_NODE_RANGE = '>=24.15 <25' as const;
export const MINIMUM_NODE = { major: 24, minor: 15, patch: 0 } as const;
export const MAXIMUM_NODE_MAJOR = 24 as const;

export interface EngineCheckResult {
  readonly supported: boolean;
  readonly detected: string;
  readonly reason?: 'too-old' | 'too-new' | 'unparseable';
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

function upgradeInstruction(): string {
  return [
    'Install Node 24.15 or newer (below Node 25):',
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
      message: `Lorepack could not parse the Node version "${detected}".\nSupported range: ${SUPPORTED_NODE_RANGE}.\n\n${upgradeInstruction()}`,
    };
  }

  const tooOld =
    version.major < MINIMUM_NODE.major ||
    (version.major === MINIMUM_NODE.major && version.minor < MINIMUM_NODE.minor);
  if (tooOld) {
    return {
      supported: false,
      detected,
      reason: 'too-old',
      message: `Lorepack requires Node ${SUPPORTED_NODE_RANGE}, but this is Node ${detected}.\nNode 24.15 is the first release with the SQLite authorizer and per-connection limits that Lorepack's SQL safety contract depends on.\n\n${upgradeInstruction()}`,
    };
  }

  if (version.major > MAXIMUM_NODE_MAJOR) {
    return {
      supported: false,
      detected,
      reason: 'too-new',
      message: `Lorepack supports Node ${SUPPORTED_NODE_RANGE}, but this is Node ${detected}.\nNode ${version.major} is untested: node:sqlite is a release candidate and its API may differ.\n\n${upgradeInstruction()}`,
    };
  }

  return { supported: true, detected };
}

/** Exits the process when the runtime is unsupported. Called from the CLI entry point. */
export function assertSupportedNode(
  detected: string = process.versions.node,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = checkNodeVersion(detected);
  if (result.supported) return;

  if (env.LORE_SKIP_ENGINE_CHECK === '1') {
    process.stderr.write(
      `warning: running on an unsupported Node (${result.detected}) because LORE_SKIP_ENGINE_CHECK=1.\nExpect failures in SQLite, search, and build determinism.\n`,
    );
    return;
  }

  process.stderr.write(`${result.message}\n`);
  process.exit(3);
}
