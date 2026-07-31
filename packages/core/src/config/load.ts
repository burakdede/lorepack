import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { LoreError } from '../errors/lore-error.js';
import { toCanonical, toPosix } from '../paths/canonical.js';
import { normalizeSourceId } from '../paths/identifiers.js';
import { configSchema, type LoreConfig } from '../schemas/config.js';
import { PRODUCT_DEFAULTS, type ProductDefaults } from './defaults.js';

export const CONFIG_FILENAME = 'lore.yaml' as const;
export const LOCKFILE_NAME = 'lore.lock' as const;
export const IGNORE_FILENAME = '.loreignore' as const;
export const LORE_DIRECTORY = '.lore' as const;

export interface ResolvedSource {
  readonly id: string;
  readonly kind: 'directory' | 'file';
  /** Absolute, for filesystem access. Never enters a hash. */
  readonly root: string;
  /** POSIX, relative to the project root. This is what identity uses. */
  readonly relativeRoot: string;
}

/**
 * The configuration a build actually runs against.
 *
 * `effective` is a build id input, so it holds no absolute path, no timestamp and no
 * environment-dependent value. Anything machine-specific lives outside it.
 */
export interface LoadedConfig {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly config: LoreConfig;
  readonly sources: readonly ResolvedSource[];
  readonly defaults: ProductDefaults;
  readonly effective: EffectiveConfig;
}

export interface EffectiveConfig {
  readonly version: 1;
  readonly defaultsVersion: number;
  readonly name: string;
  /** POSIX, relative to the project root, sorted. */
  readonly sources: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly followSymlinks: boolean;
  readonly strictRules: boolean;
  readonly includeOriginals: boolean;
  readonly chunking: ProductDefaults['chunking'];
  readonly limits: ProductDefaults['limits'];
  readonly contextProfile: string;
  readonly rules: readonly {
    readonly match: string;
    readonly status?: string;
    readonly authority?: number;
    readonly supersedes?: readonly string[];
    readonly replace?: boolean;
  }[];
}

/** Walks up from `start` looking for lore.yaml, stopping at the filesystem boundary. */
export function findProjectRoot(start: string): string | null {
  let current = resolve(start);
  const { root } = parsePath(current);
  for (;;) {
    if (existsSync(join(current, CONFIG_FILENAME))) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function notInitialized(start: string): LoreError {
  return new LoreError(
    'LORE_E_NOT_INITIALIZED',
    `No ${CONFIG_FILENAME} found in ${toPosix(start)} or any parent directory.`,
    {
      remediation: `Run \`lore init\` here, or pass --cwd pointing at a Lorepack project.`,
    },
  );
}

interface YamlPosition {
  readonly line: number;
  readonly column: number;
}

/** Line and column for a config key, which is what turns a validation error into a fix. */
function positionOf(source: string, offset: number | undefined): YamlPosition | null {
  if (offset === undefined || offset < 0 || offset > source.length) return null;
  const upto = source.slice(0, offset);
  const lines = upto.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function readConfigFile(configPath: string): { config: LoreConfig; raw: string } {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (cause) {
    throw new LoreError('LORE_E_CONFIG_INVALID', `Could not read ${CONFIG_FILENAME}.`, {
      path: CONFIG_FILENAME,
      cause,
    });
  }

  const document = parseDocument(raw, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    const first = document.errors[0];
    const position = positionOf(raw, first?.pos?.[0]);
    throw new LoreError(
      'LORE_E_CONFIG_INVALID',
      `${CONFIG_FILENAME} is not valid YAML${position === null ? '' : ` at line ${position.line}, column ${position.column}`}: ${first?.message ?? 'unknown error'}`,
      {
        remediation: 'Fix the YAML syntax. Indentation is the usual cause.',
        path: CONFIG_FILENAME,
      },
    );
  }

  const parsed = configSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const keyPath = (issue?.path ?? []).join('.');
    const node = keyPath === '' ? undefined : document.getIn((issue?.path ?? []) as string[], true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    const position = positionOf(raw, range?.[0]);
    const where =
      position === null
        ? keyPath === ''
          ? ''
          : ` at \`${keyPath}\``
        : ` at \`${keyPath}\` (line ${position.line}, column ${position.column})`;
    throw new LoreError(
      'LORE_E_CONFIG_INVALID',
      `${CONFIG_FILENAME} is invalid${where}: ${issue?.message ?? 'unknown problem'}`,
      {
        remediation: suggestionFor(issue?.code, keyPath),
        path: CONFIG_FILENAME,
        details: {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    );
  }

  return { config: parsed.data, raw };
}

const KNOWN_KEYS = ['version', 'name', 'sources', 'rules', 'context', 'package', 'strictRules'];

function suggestionFor(code: string | undefined, keyPath: string): string {
  if (code === 'unrecognized_keys') {
    const closest = closestKey(keyPath.split('.').at(-1) ?? '');
    return closest === null
      ? `Remove the unknown key. Valid top-level keys: ${KNOWN_KEYS.join(', ')}.`
      : `Did you mean \`${closest}\`? Valid top-level keys: ${KNOWN_KEYS.join(', ')}.`;
  }
  return `See schemas/lore-config.json for the full configuration contract.`;
}

function closestKey(candidate: string): string | null {
  let best: { key: string; distance: number } | null = null;
  for (const key of KNOWN_KEYS) {
    const distance = editDistance(candidate.toLowerCase(), key.toLowerCase());
    if (best === null || distance < best.distance) best = { key, distance };
  }
  return best !== null && best.distance <= 3 ? best.key : null;
}

/** Levenshtein distance, used only to suggest the key the user probably meant. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current.push(Math.min(deletion, insertion, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function resolveSources(projectRoot: string, config: LoreConfig): ResolvedSource[] {
  const sources: ResolvedSource[] = [];
  const seen = new Set<string>();

  for (const declared of config.sources) {
    // lore.yaml is committed and therefore portable. A path written on Windows as
    // "docs\\sub" must resolve on Linux, so separators are interpreted POSIX-style
    // rather than natively. The cost is that a literal backslash in a filename cannot be
    // named from configuration, which is a limitation worth stating and not worth
    // supporting: canonical paths are POSIX everywhere else too.
    const normalized = toPosix(declared);

    if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Source paths must be relative to the project: ${declared}`,
        {
          remediation:
            'Use a path like ./project-context. An absolute path makes the configuration specific to one machine, and lore.yaml is meant to be committed.',
          path: CONFIG_FILENAME,
          subject: declared,
        },
      );
    }

    const absolute = resolve(projectRoot, normalized);

    if (!existsSync(absolute)) {
      throw new LoreError('LORE_E_CONFIG_INVALID', `Source path does not exist: ${declared}`, {
        remediation: 'Create the directory, or remove it from `sources` in lore.yaml.',
        path: CONFIG_FILENAME,
        subject: declared,
      });
    }

    // Containment is checked against the project root using the same rules as discovery,
    // so a source cannot reach outside the project by any spelling.
    const relativeRoot =
      resolve(absolute) === resolve(projectRoot) ? '.' : toCanonical(projectRoot, absolute);

    if (seen.has(relativeRoot)) {
      throw new LoreError('LORE_E_CONFIG_INVALID', `Duplicate source: ${declared}`, {
        remediation: 'Each source must appear once.',
        path: CONFIG_FILENAME,
        subject: declared,
      });
    }
    seen.add(relativeRoot);

    sources.push({
      id: normalizeSourceId(relativeRoot === '.' ? config.name : relativeRoot),
      kind: statSync(absolute).isDirectory() ? 'directory' : 'file',
      root: absolute,
      relativeRoot,
    });
  }

  return sources;
}

function buildEffective(
  config: LoreConfig,
  sources: readonly ResolvedSource[],
  defaults: ProductDefaults,
): EffectiveConfig {
  return deepFreeze({
    version: 1,
    defaultsVersion: defaults.defaultsVersion,
    name: config.name,
    sources: [...sources.map((source) => source.relativeRoot)].sort(),
    include: [...defaults.include],
    exclude: [...defaults.exclude],
    followSymlinks: defaults.followSymlinks,
    strictRules: config.strictRules ?? defaults.strictRules,
    includeOriginals: config.package?.includeOriginals ?? defaults.includeOriginals,
    chunking: defaults.chunking,
    limits: defaults.limits,
    contextProfile: config.context?.defaultProfile ?? defaults.contextProfile,
    rules: (config.rules ?? []).map((rule) => ({
      match: rule.match,
      ...(rule.status === undefined ? {} : { status: rule.status }),
      ...(rule.authority === undefined ? {} : { authority: rule.authority }),
      ...(rule.supersedes === undefined ? {} : { supersedes: [...rule.supersedes] }),
      ...(rule.replace === undefined ? {} : { replace: rule.replace }),
    })),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

export interface LoadOptions {
  readonly cwd?: string;
  readonly defaults?: ProductDefaults;
}

/** Layers one and two of the precedence in architecture section 6.8. Phase 3 adds the rest. */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const start = resolve(options.cwd ?? process.cwd());
  const projectRoot = findProjectRoot(start);
  if (projectRoot === null) throw notInitialized(start);

  const configPath = join(projectRoot, CONFIG_FILENAME);
  const { config } = readConfigFile(configPath);
  const defaults = options.defaults ?? PRODUCT_DEFAULTS;
  const sources = resolveSources(projectRoot, config);

  return deepFreeze({
    projectRoot,
    configPath,
    config,
    sources,
    defaults,
    effective: buildEffective(config, sources, defaults),
  });
}
