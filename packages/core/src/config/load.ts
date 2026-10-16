import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { LoreError } from '../errors/lore-error.js';
import { toCanonical, toPosix } from '../paths/canonical.js';
import { normalizeSourceId } from '../paths/identifiers.js';
import { configSchema, type LoreConfig } from '../schemas/config.js';
import { closestMatch } from '../text/closest.js';
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

export interface ProjectConfig {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly config: LoreConfig;
  readonly defaults: ProductDefaults;
}

/**
 * Validated source configuration for compilation. `effective` is a build ID input, so
 * machine-specific paths and timestamps stay outside it.
 */
export interface LoadedConfig extends ProjectConfig {
  readonly sources: readonly ResolvedSource[];
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
  readonly build: ProductDefaults['build'];
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
      remediation: `Run \`lorepack init\` here, or pass --cwd pointing at a Lorepack project.`,
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

export function readConfigFile(configPath: string): {
  config: LoreConfig;
  raw: string;
} {
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
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      },
    );
  }

  return { config: parsed.data, raw };
}

const KNOWN_KEYS = [
  'version',
  'name',
  'sources',
  'rules',
  'context',
  'package',
  'strictRules',
  'build',
];

function suggestionFor(code: string | undefined, keyPath: string): string {
  if (code === 'unrecognized_keys') {
    const closest = closestMatch(keyPath.split('.').at(-1) ?? '', KNOWN_KEYS);
    return closest === null
      ? `Remove the unknown key. Valid top-level keys: ${KNOWN_KEYS.join(', ')}.`
      : `Did you mean \`${closest}\`? Valid top-level keys: ${KNOWN_KEYS.join(', ')}.`;
  }
  return `See schemas/lore-config.json for the full configuration contract.`;
}

function resolveSources(projectRoot: string, config: LoreConfig): ResolvedSource[] {
  const sources: ResolvedSource[] = [];
  const realRoots: string[] = [];
  const seen = new Set<string>();
  // The project root may itself sit behind a link (/tmp is /private/tmp on macOS), so the
  // sources are compared with its real path, never with the spelling the walk-up found.
  const realProjectRoot = realpathSync(projectRoot);

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

    // Containment is checked twice. The lexical check refuses `../elsewhere` by any
    // spelling; the real-path check refuses a source that is, or passes through, a symbolic
    // link out of the project. Discovery only inspects entries below a root, so without the
    // second check `docs -> ../../` would carry the whole build outside (issue 583).
    const relativeRoot =
      resolve(absolute) === resolve(projectRoot) ? '.' : toCanonical(projectRoot, absolute);
    const realRoot = realpathSync(absolute);
    if (!isWithin(realProjectRoot, realRoot)) {
      throw new LoreError(
        'LORE_E_PATH_ESCAPE',
        `Source ${declared} resolves outside the project through a symbolic link.`,
        {
          remediation:
            'Point the link inside the project, or copy the content in. A source must live inside the project so the build can be reproduced from it.',
          path: CONFIG_FILENAME,
          subject: declared,
          details: { target: toPosix(realRoot) },
        },
      );
    }

    // Stat the real target rather than the link, and accept only the two kinds discovery
    // knows how to read. A FIFO or a device as a file source would block or never end.
    const stats = statSync(realRoot);
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Source ${declared} is not a regular file or a directory.`,
        {
          remediation: 'Name a directory or a regular file in `sources` in lore.yaml.',
          path: CONFIG_FILENAME,
          subject: declared,
        },
      );
    }

    if (seen.has(relativeRoot)) {
      throw new LoreError('LORE_E_CONFIG_INVALID', `Duplicate source: ${declared}`, {
        remediation: 'Each source must appear once.',
        path: CONFIG_FILENAME,
        subject: declared,
      });
    }
    seen.add(relativeRoot);

    const sourceId = normalizeSourceId(relativeRoot === '.' ? config.name : relativeRoot);
    const sameId = sources.find((source) => source.id === sourceId);
    if (sameId !== undefined) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Source roots ${sameId.relativeRoot} and ${relativeRoot} resolve to the same source ID: ${sourceId}`,
        {
          remediation: 'Rename one source root so every source has a distinct normalized ID.',
          path: CONFIG_FILENAME,
          subject: sourceId,
          details: { roots: [sameId.relativeRoot, relativeRoot] },
        },
      );
    }

    // Overlap on real paths too: two names for one directory would index each file twice.
    const overlapping = sources[realRoots.findIndex((root) => rootsOverlap(root, realRoot))];
    if (overlapping !== undefined) {
      throw new LoreError(
        'LORE_E_CONFIG_INVALID',
        `Source roots ${overlapping.relativeRoot} and ${relativeRoot} overlap.`,
        {
          remediation: 'Use non-overlapping source roots so each file is indexed once.',
          path: CONFIG_FILENAME,
          subject: relativeRoot,
          details: { roots: [overlapping.relativeRoot, relativeRoot] },
        },
      );
    }

    realRoots.push(realRoot);
    sources.push({
      id: sourceId,
      kind: stats.isDirectory() ? 'directory' : 'file',
      root: absolute,
      relativeRoot,
    });
  }

  return sources;
}

function rootsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, candidate: string): boolean {
  const path = toPosix(relative(root, candidate));
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
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
    build: {
      profile: config.build?.profile ?? defaults.build.profile,
      required: [...(config.build?.required ?? defaults.build.required)]
        .map((source) => ({
          path: source.path,
          ...(source.sheets === undefined ? {} : { sheets: [...source.sheets].sort() }),
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    },
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

/**
 * Where `.lore` really lives when it is a link out of the project, or null when it is not.
 *
 * A repository can ship `.lore` as a symbolic link, and every write Lorepack makes (objects
 * holding copies of every source, state, builds) would then land wherever it points, silently
 * (#572). A link that stays inside the project is harmless and allowed.
 */
export function loreDirectoryEscape(projectRoot: string): string | null {
  const path = join(projectRoot, LORE_DIRECTORY);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return null;
  }
  if (!stats.isSymbolicLink()) return null;
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    // A dangling link would be followed by the first `mkdir`, so it is refused too.
    return toPosix(resolve(dirname(path), String(readlinkTarget(path))));
  }
  return isWithin(realpathSync(projectRoot), target) ? null : toPosix(target);
}

function readlinkTarget(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    return path;
  }
}

function assertLoreDirectoryContained(projectRoot: string): void {
  const target = loreDirectoryEscape(projectRoot);
  if (target === null) return;
  throw new LoreError(
    'LORE_E_PATH_ESCAPE',
    `${LORE_DIRECTORY} is a link to a directory outside the project.`,
    {
      remediation: `Remove the link and let Lorepack create ${LORE_DIRECTORY} inside the project. Builds hold copies of every source, so they must not be written somewhere the project does not control.`,
      path: LORE_DIRECTORY,
      details: { target },
    },
  );
}

/** Layers one and two of the precedence in architecture section 6.8. Phase 3 adds the rest. */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  return loadSourceConfig(loadProjectConfig(options));
}

/** Retained-build operations need project containment, not the original source tree. */
export function loadProjectConfig(options: LoadOptions = {}): ProjectConfig {
  const start = resolve(options.cwd ?? process.cwd());
  const projectRoot = findProjectRoot(start);
  if (projectRoot === null) throw notInitialized(start);

  assertLoreDirectoryContained(projectRoot);
  const configPath = join(projectRoot, CONFIG_FILENAME);
  const { config } = readConfigFile(configPath);
  const defaults = options.defaults ?? PRODUCT_DEFAULTS;
  return deepFreeze({
    projectRoot,
    configPath,
    config,
    defaults,
  });
}

export function loadSourceConfig(project: ProjectConfig): LoadedConfig {
  const sources = resolveSources(project.projectRoot, project.config);
  return deepFreeze({
    ...project,
    sources,
    effective: buildEffective(project.config, sources, project.defaults),
  });
}
