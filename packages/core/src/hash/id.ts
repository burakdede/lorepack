import { LoreError } from '../errors/lore-error.js';

export type BuildId = `lore_${string}`;

export const BUILD_ID_PREFIX = 'lore_' as const;
export const DEFAULT_DISPLAY_LENGTH = 12 as const;

const BUILD_ID_PATTERN = /^lore_[0-9a-f]{64}$/;

export function isBuildId(value: string): value is BuildId {
  return BUILD_ID_PATTERN.test(value);
}

export function assertBuildId(value: string): BuildId {
  if (!isBuildId(value)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `Not a valid build identifier: ${value}`, {
      remediation: 'Use a full build id, or a unique prefix of one. Run `lore inspect builds`.',
      subject: value,
    });
  }
  return value;
}

/**
 * Shortest unambiguous prefix for display, never below 12 characters. Manifests, APIs and
 * directories always store the full digest; only humans see the short form.
 */
export function formatBuildId(
  id: BuildId,
  known: readonly BuildId[] = [],
  minimum: number = DEFAULT_DISPLAY_LENGTH,
): string {
  const digest = id.slice(BUILD_ID_PREFIX.length);
  const others = known
    .filter((candidate) => candidate !== id)
    .map((candidate) => candidate.slice(BUILD_ID_PREFIX.length));
  let length = Math.max(minimum, 1);
  while (length < digest.length) {
    const prefix = digest.slice(0, length);
    if (!others.some((other) => other.startsWith(prefix))) break;
    length += 1;
  }
  return `${BUILD_ID_PREFIX}${digest.slice(0, length)}`;
}

/** Resolves a user-supplied prefix against known builds. */
export function resolveBuildIdPrefix(prefix: string, known: readonly BuildId[]): BuildId {
  const normalized = prefix.startsWith(BUILD_ID_PREFIX)
    ? prefix.slice(BUILD_ID_PREFIX.length)
    : prefix;
  const matches = known.filter((id) => id.slice(BUILD_ID_PREFIX.length).startsWith(normalized));
  if (matches.length === 1) return matches[0] as BuildId;
  if (matches.length === 0) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No build matches ${prefix}.`, {
      remediation: 'Run `lore inspect builds` to list available builds.',
      subject: prefix,
    });
  }
  throw new LoreError('LORE_E_BUILD_NOT_FOUND', `${prefix} is ambiguous.`, {
    remediation: `Use more characters. Candidates: ${matches.map((match) => formatBuildId(match, matches)).join(', ')}`,
    subject: prefix,
    details: { candidates: matches },
  });
}
