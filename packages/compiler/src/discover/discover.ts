import { lstatSync, readdirSync, realpathSync, type Stats, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  ALWAYS_EXCLUDE,
  artifactId,
  assertNoCaseCollisions,
  compareCanonical,
  count,
  IGNORE_FILENAME,
  LORE_DIRECTORY,
  type LoadedConfig,
  LoreError,
  type ProgressBus,
  type ResolvedSource,
  SECRET_SHAPED,
  toCanonical,
  toPosix,
} from '@lorepack/core';
import { formatFor, isPlannedFormat } from '@lorepack/parsers';
import { createMatcher, type IgnoreRule, readIgnoreRules } from './ignore.js';

export interface DiscoveredArtifact {
  readonly artifactId: string;
  readonly sourceId: string;
  /** POSIX, relative to the source root. The only form that enters identity. */
  readonly relativePath: string;
  /** Native, for filesystem access and user-facing output. */
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly mediaType: string;
  readonly parserId: string;
  readonly byteSize: number;
}

export type DiscoveryWarningCode =
  | 'unsupported-format'
  | 'planned-format'
  | 'symlink-skipped'
  | 'artifact-too-large'
  | 'envelope-bytes'
  | 'unreadable'
  /**
   * A supported extension whose bytes are not readable text. Decided while fingerprinting,
   * because it is the only stage that reads the content, but it is the same kind of verdict
   * as the others here: a file the build left out, named rather than silently missing.
   */
  | 'undecodable-content';

export interface DiscoveryWarning {
  readonly code: DiscoveryWarningCode;
  readonly path: string;
  readonly message: string;
}

/**
 * What one ignore rule removed, accumulated as the walk runs.
 *
 * A rule rather than a file is the unit, because the number of files a rule removes is
 * bounded by the corpus and the number of rules is bounded by the configuration. Recording
 * per file would put 200,000 rows in a build for one line of `.loreignore`.
 *
 * The walk still visits every excluded file to count it, which is what it already did: only
 * `consider` consulted the matcher, so a dependency tree was always enumerated in full.
 * Pruning an excluded directory instead would be faster and is what git does, but it changes
 * what a negation can reach (nothing looks inside a directory that was never entered), so it
 * belongs in its own change with its own tests rather than riding along with this one.
 */
export interface DiscoveryExclusion {
  readonly pattern: string;
  readonly source: string;
  readonly count: number;
  /** Capped and sorted, so two builds of identical inputs record identical bytes. */
  readonly sample: readonly string[];
}

/** Enough to recognise what a rule took, without becoming a second listing of the corpus. */
export const EXCLUSION_SAMPLE_LIMIT = 5;

export interface DiscoveryResult {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly warnings: readonly DiscoveryWarning[];
  /** Grouped by the rule that decided, ordered by what each removed. */
  readonly exclusions: readonly DiscoveryExclusion[];
  readonly totalBytes: number;
  readonly rules: readonly IgnoreRule[];
}

export interface DiscoverOptions {
  readonly config: LoadedConfig;
  readonly progress?: ProgressBus;
  /** Required past the supported file count, per architecture section 5.4. */
  readonly allowLargeProject?: boolean;
}

/**
 * The rules that decide whether a path is a source of this project.
 *
 * Exported because discovery is not the only thing that has to answer that question: watch
 * mode decides which filesystem events matter, and two matchers built from the same
 * ingredients in two places is how they come to disagree about one file.
 */
export function createSourceMatcher(config: LoadedConfig): ReturnType<typeof createMatcher> {
  const rules: IgnoreRule[] = [
    ...ALWAYS_EXCLUDE.map((pattern) => ({
      pattern,
      negated: false,
      source: 'defaults',
      nocase: SECRET_SHAPED.includes(pattern),
    })),
    ...readIgnoreRules(config.projectRoot, IGNORE_FILENAME),
  ];
  return createMatcher(rules);
}

export function sourceRootExclusion(
  source: ResolvedSource,
  matcher: ReturnType<typeof createSourceMatcher>,
): { readonly rule: IgnoreRule; readonly path: string } | null {
  const parts = source.relativeRoot === '.' ? [] : source.relativeRoot.split('/');
  const directoryCount = source.kind === 'file' ? parts.length - 1 : parts.length;
  for (let depth = 1; depth <= directoryCount; depth += 1) {
    const path = parts.slice(0, depth).join('/');
    const rule = matcher.decideDirectory(path);
    if (rule !== null) return { rule, path };
  }
  return null;
}

/**
 * Walks the configured sources and decides what belongs in a build.
 *
 * Every exclusion is reported. Architecture section 6.9 is explicit that an unsupported
 * file is excluded "with a visible warning and exact path", because silently indexing
 * nothing is indistinguishable from a broken build.
 */
export function discover(options: DiscoverOptions): DiscoveryResult {
  const { config } = options;
  const matcher = createSourceMatcher(config);

  const artifacts: DiscoveredArtifact[] = [];
  const warnings: DiscoveryWarning[] = [];
  const excluded = createExclusionLog();
  let totalBytes = 0;

  options.progress?.start('discovering', 'Discovering');

  for (const source of config.sources) {
    walkSource(source, config, matcher, artifacts, warnings, excluded, () => {
      totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0);
      options.progress?.progress('discovering', artifacts.length, { unit: 'files' });
    });
  }

  totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0);

  // Deterministic order, independent of how the filesystem enumerated anything.
  artifacts.sort((a, b) => compareCanonical(a.artifactId, b.artifactId));
  assertNoCaseCollisions(artifacts.map((artifact) => artifact.artifactId));

  enforceEnvelope(artifacts, totalBytes, config, warnings, options);
  options.progress?.finish('discovering', artifacts.length);

  return {
    artifacts,
    warnings,
    exclusions: excluded.collect(),
    totalBytes,
    rules: matcher.rules,
  };
}

interface ExclusionLog {
  /** Records one path against the rule that removed it. */
  readonly record: (rule: IgnoreRule, path: string) => void;
  readonly collect: () => DiscoveryExclusion[];
}

function createExclusionLog(): ExclusionLog {
  const byRule = new Map<string, { rule: IgnoreRule; count: number; sample: string[] }>();

  return {
    record(rule, path) {
      // Lorepack's own directory is not a document that failed to make it, and its contents
      // move while a build runs: the lock file exists for the duration, the cache and the
      // sealed builds accumulate. Recording it would put "2 paths removed: .lore/lock/
      // owner.json, .lore/state.sqlite" in front of a reader looking for their own missing
      // document, and would make two builds of identical sources record different bytes.
      if (path === LORE_DIRECTORY || path.startsWith(`${LORE_DIRECTORY}/`)) return;

      // Keyed on both, because the same pattern can legitimately appear in the defaults and
      // in a project's own file, and a reader looking for the line that removed their folder
      // needs to be told which of the two it was.
      const key = `${rule.source}\0${rule.pattern}`;
      const entry = byRule.get(key) ?? { rule, count: 0, sample: [] };
      entry.count += 1;
      if (entry.sample.length < EXCLUSION_SAMPLE_LIMIT) entry.sample.push(path);
      byRule.set(key, entry);
    },
    collect() {
      return [...byRule.values()]
        .map((entry) => ({
          pattern: entry.rule.pattern,
          source: entry.rule.source,
          count: entry.count,
          // Sorted rather than left in enumeration order: the walk visits sorted entries, but
          // a build must not depend on that holding for every filesystem on every platform.
          sample: [...entry.sample].sort(compareCanonical),
        }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            compareCanonical(a.source, b.source) ||
            compareCanonical(a.pattern, b.pattern),
        );
    },
  };
}

function walkSource(
  source: ResolvedSource,
  config: LoadedConfig,
  matcher: ReturnType<typeof createMatcher>,
  artifacts: DiscoveredArtifact[],
  warnings: DiscoveryWarning[],
  excluded: ExclusionLog,
  onProgress: () => void,
): void {
  const limits = config.effective.limits;
  const followSymlinks = config.effective.followSymlinks;

  // A file source is canonicalized against its parent: relative to itself it would be the
  // empty path, which is not an identity.
  const canonicalRoot = source.kind === 'file' ? dirname(source.root) : source.root;

  const consider = (absolute: string): void => {
    let canonical: string;
    try {
      canonical = toCanonical(canonicalRoot, absolute);
    } catch {
      // Outside the source root. toCanonical already refused it; discovery does not
      // second-guess that, it just does not index the file.
      return;
    }
    const projectPath = toCanonical(config.projectRoot, absolute);
    const rule = matcher.decide(projectPath);
    if (rule !== null) {
      excluded.record(rule, projectPath);
      return;
    }

    const filename = absolute.split(/[\\/]/).at(-1) ?? '';
    const format = formatFor(filename);
    const display = toPosix(relative(config.projectRoot, absolute).split(sep).join('/'));

    if (format === null || !format.available) {
      warnings.push({
        code: isPlannedFormat(filename) ? 'planned-format' : 'unsupported-format',
        path: display,
        message: isPlannedFormat(filename)
          ? `${display} is a format Lorepack will support in a later release, so it was not indexed.`
          : `${display} has no supported parser, so it was not indexed.`,
      });
      return;
    }

    let size: number;
    try {
      size = statSync(absolute).size;
    } catch {
      warnings.push({
        code: 'unreadable',
        path: display,
        message: `${display} could not be read.`,
      });
      return;
    }

    if (size > limits.maxArtifactBytes) {
      warnings.push({
        code: 'artifact-too-large',
        path: display,
        message: `${display} is ${formatBytes(size)}, above the ${formatBytes(limits.maxArtifactBytes)} limit for a single artifact.`,
      });
      return;
    }

    artifacts.push({
      artifactId: artifactId(source.id, canonical),
      sourceId: source.id,
      relativePath: canonical,
      absolutePath: absolute,
      displayPath: display,
      mediaType: format.mediaType,
      parserId: format.parserId,
      byteSize: size,
    });
    if (artifacts.length % 200 === 0) onProgress();
  };

  /**
   * Whether a directory can be skipped without descending into it.
   *
   * This is the whole of #209. Before it, discovery walked into every directory and decided
   * per file, so a `node_modules` holding two hundred thousand files was enumerated in full,
   * one `readdirSync` and one `lstatSync` at a time, on every build, every plan, every
   * `lore status` and every watcher sweep, in order to conclude two hundred thousand times
   * that it was excluded.
   *
   * A pruned directory is recorded **once**, naming the directory. `lore inspect exclusions`
   * saying `node_modules/` is a better answer than the same rule reported against each of its
   * files, and it is the honest one: the walk genuinely did not look inside.
   */
  const prune = (absolute: string): boolean => {
    let canonical: string;
    try {
      canonical = toCanonical(config.projectRoot, absolute);
    } catch {
      return false;
    }
    const rule = matcher.decideDirectory(canonical);
    if (rule === null) return false;
    excluded.record(rule, `${canonical}/`);
    return true;
  };

  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      warnings.push({
        code: 'unreadable',
        path: toPosix(relative(config.projectRoot, directory).split(sep).join('/')),
        message: `${directory} could not be listed.`,
      });
      return;
    }

    for (const entry of entries.sort()) {
      const full = join(directory, entry);
      const link = safeLstat(full);
      if (link === null) {
        warnings.push(unreadableWarning(config, full));
        continue;
      }

      if (link.isSymbolicLink()) {
        if (!followSymlinks) {
          warnings.push({
            code: 'symlink-skipped',
            path: toPosix(relative(config.projectRoot, full).split(sep).join('/')),
            message: `${entry} is a symbolic link and was skipped. Set followSymlinks to include them.`,
          });
          continue;
        }
        // Following is opt-in, but escaping the root never is: resolve the real path and
        // check containment on that. A symlink out of the project would otherwise
        // canonicalize cleanly and pass the containment check on a lie.
        const real = safeRealpath(full);
        if (real === null) {
          warnings.push(unreadableWarning(config, full));
          continue;
        }
        if (!isInside(canonicalRoot, real)) {
          throw new LoreError(
            'LORE_E_PATH_ESCAPE',
            `${toPosix(relative(config.projectRoot, full).split(sep).join('/'))} is a symbolic link pointing outside the source root.`,
            {
              remediation:
                'Remove the link, point it inside the project, or disable followSymlinks.',
              path: toPosix(relative(config.projectRoot, full).split(sep).join('/')),
              details: { target: toPosix(real) },
            },
          );
        }
        const realStat = safeStat(real);
        if (realStat === null) {
          warnings.push(unreadableWarning(config, full));
          continue;
        }
        if (realStat.isDirectory() && !prune(full)) walk(full);
        else consider(full);
        continue;
      }

      if (link.isDirectory()) {
        if (!prune(full)) walk(full);
      } else if (link.isFile()) consider(full);
    }
  };

  const rootExclusion = sourceRootExclusion(source, matcher);
  if (rootExclusion !== null) {
    excluded.record(rootExclusion.rule, `${rootExclusion.path}/`);
    return;
  }

  if (source.kind === 'file') consider(source.root);
  else walk(source.root);
}

function isInside(root: string, candidate: string): boolean {
  // Compare real paths on both sides: the root itself may sit behind a symlink, which is
  // common on macOS where /tmp resolves to /private/tmp.
  const resolvedRoot = safeRealpath(root) ?? root;
  const rel = relative(resolvedRoot, candidate);
  return rel !== '' && !rel.startsWith('..') && !/^[A-Za-z]:/.test(rel);
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function unreadableWarning(config: LoadedConfig, absolute: string): DiscoveryWarning {
  const path = toPosix(relative(config.projectRoot, absolute).split(sep).join('/'));
  return {
    code: 'unreadable',
    path,
    message: `${path} could not be read.`,
  };
}

function enforceEnvelope(
  artifacts: readonly DiscoveredArtifact[],
  totalBytes: number,
  config: LoadedConfig,
  warnings: DiscoveryWarning[],
  options: DiscoverOptions,
): void {
  const limits = config.effective.limits;

  if (artifacts.length > limits.maxSourceFiles && options.allowLargeProject !== true) {
    throw new LoreError(
      'LORE_E_ENVELOPE_EXCEEDED',
      `This project has ${count(artifacts.length, 'file')}, above the supported envelope of ${limits.maxSourceFiles.toLocaleString('en-US')}.`,
      {
        remediation:
          'Narrow `sources` or add exclusions to .loreignore, or pass --allow-large-project to continue anyway. Beyond the envelope, performance is untested rather than unsupported.',
        details: { files: artifacts.length, limit: limits.maxSourceFiles },
      },
    );
  }

  if (totalBytes > limits.maxTotalBytes) {
    const largest = [...artifacts]
      .sort((a, b) => b.byteSize - a.byteSize)
      .slice(0, 5)
      .map((artifact) => `${artifact.displayPath} (${formatBytes(artifact.byteSize)})`);
    warnings.push({
      code: 'envelope-bytes',
      path: '.',
      message: `Sources total ${formatBytes(totalBytes)}, above the ${formatBytes(limits.maxTotalBytes)} envelope. Largest: ${largest.join(', ')}.`,
    });
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
