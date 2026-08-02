import { lstatSync, readdirSync, realpathSync, type Stats, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  ALWAYS_EXCLUDE,
  artifactId,
  assertNoCaseCollisions,
  compareCanonical,
  IGNORE_FILENAME,
  type LoadedConfig,
  LoreError,
  type ProgressBus,
  type ResolvedSource,
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

export interface DiscoveryResult {
  readonly artifacts: readonly DiscoveredArtifact[];
  readonly warnings: readonly DiscoveryWarning[];
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
 * Walks the configured sources and decides what belongs in a build.
 *
 * Every exclusion is reported. Architecture section 6.9 is explicit that an unsupported
 * file is excluded "with a visible warning and exact path", because silently indexing
 * nothing is indistinguishable from a broken build.
 */
export function discover(options: DiscoverOptions): DiscoveryResult {
  const { config } = options;
  const rules: IgnoreRule[] = [
    ...ALWAYS_EXCLUDE.map((pattern) => ({ pattern, negated: false, source: 'defaults' })),
    ...readIgnoreRules(config.projectRoot, IGNORE_FILENAME),
  ];
  const matcher = createMatcher(rules);

  const artifacts: DiscoveredArtifact[] = [];
  const warnings: DiscoveryWarning[] = [];
  let totalBytes = 0;

  options.progress?.start('discovering', 'Discovering');

  for (const source of config.sources) {
    walkSource(source, config, matcher, artifacts, warnings, () => {
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

  return { artifacts, warnings, totalBytes, rules };
}

function walkSource(
  source: ResolvedSource,
  config: LoadedConfig,
  matcher: ReturnType<typeof createMatcher>,
  artifacts: DiscoveredArtifact[],
  warnings: DiscoveryWarning[],
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
    if (matcher.excludes(canonical)) return;

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
      if (link === null) continue;

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
        if (real === null) continue;
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
        if (realStat === null) continue;
        if (realStat.isDirectory()) walk(full);
        else consider(full);
        continue;
      }

      if (link.isDirectory()) walk(full);
      else if (link.isFile()) consider(full);
    }
  };

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
      `This project has ${artifacts.length.toLocaleString('en-US')} files, above the supported envelope of ${limits.maxSourceFiles.toLocaleString('en-US')}.`,
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
