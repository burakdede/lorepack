/**
 * Stable, machine-readable error codes. Scripts and CI branch on these, and the
 * documentation deep-links to them, so a code is part of the public contract:
 * rename one only with a changeset and a documentation update.
 */
export const ERROR_CODES = {
  // Environment and capability (exit 3)
  LORE_E_UNSUPPORTED_NODE: 'The Node runtime is outside the supported range.',
  LORE_E_FTS5_UNAVAILABLE: 'The SQLite build has no FTS5 module, so lexical search cannot work.',
  LORE_E_SQLITE_UNAVAILABLE: 'The node:sqlite module is unavailable or failed to open a database.',

  // User and configuration (exit 1)
  LORE_E_NOT_INITIALIZED: 'No Lorepack project was found at this path.',
  LORE_E_CONFIG_INVALID: 'The project configuration failed validation.',
  LORE_E_PATH_ESCAPE: 'A path resolved outside its configured source root.',
  LORE_E_CASE_COLLISION: 'Two source paths differ only by case.',
  LORE_E_UNSUPPORTED_FORMAT: 'The file format is not supported for indexing.',
  LORE_E_SOURCE_UNREADABLE: 'A source file exists but could not be read.',
  LORE_E_ARTIFACT_TOO_LARGE: 'An artifact exceeds the configured size cap.',
  LORE_E_ENVELOPE_EXCEEDED: 'The project exceeds a supported scale limit.',
  LORE_E_BUILD_NOT_FOUND: 'No build matches the requested identifier.',
  LORE_E_INVALID_ARGUMENT: 'A command argument was missing or invalid.',
  LORE_E_CANCELLED: 'The operation was cancelled before it completed.',

  // Build integrity (exit 2)
  LORE_E_PARSE_FAILED: 'A supported, included file could not be parsed.',
  LORE_E_BUILD_VALIDATION: 'The candidate build failed a validation check.',
  LORE_E_OBJECT_CORRUPT: 'A content-addressed object failed its checksum.',
  LORE_E_LOCKFILE_DRIFT: 'The lockfile would change, but the build was run with --frozen.',
  LORE_E_STALE_SOURCES: 'Sources changed and the project could not be rebuilt.',

  // Concurrency (exit 4)
  LORE_E_LOCK_HELD: 'Another Lorepack process holds the project lock.',

  // Runtime safety (exit 1)
  LORE_E_SQL_REJECTED: 'The query was rejected by the read-only SQL policy.',
  LORE_E_LIMIT_EXCEEDED: 'A request exceeded a configured size, row, or time limit.',

  // Remote (exit 5)
  LORE_E_TARGET_NOT_CONFIGURED: 'The deployment target has not been set up.',
  LORE_E_CAPABILITY_LOSS: 'The target cannot serve a capability this build advertises.',
  LORE_E_REMOTE_DEPLOY: 'A remote deployment step failed.',

  // Unclassified (exit 1)
  LORE_E_INTERNAL: 'An unexpected internal error occurred.',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const EXIT_CODES = {
  USER: 1,
  BUILD: 2,
  ENVIRONMENT: 3,
  CONCURRENCY: 4,
  REMOTE: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const EXIT_BY_CODE: Readonly<Record<ErrorCode, ExitCode>> = {
  LORE_E_UNSUPPORTED_NODE: EXIT_CODES.ENVIRONMENT,
  LORE_E_FTS5_UNAVAILABLE: EXIT_CODES.ENVIRONMENT,
  LORE_E_SQLITE_UNAVAILABLE: EXIT_CODES.ENVIRONMENT,
  LORE_E_NOT_INITIALIZED: EXIT_CODES.USER,
  LORE_E_CONFIG_INVALID: EXIT_CODES.USER,
  LORE_E_PATH_ESCAPE: EXIT_CODES.USER,
  LORE_E_CASE_COLLISION: EXIT_CODES.USER,
  LORE_E_UNSUPPORTED_FORMAT: EXIT_CODES.USER,
  LORE_E_SOURCE_UNREADABLE: EXIT_CODES.USER,
  LORE_E_ARTIFACT_TOO_LARGE: EXIT_CODES.USER,
  LORE_E_ENVELOPE_EXCEEDED: EXIT_CODES.USER,
  LORE_E_BUILD_NOT_FOUND: EXIT_CODES.USER,
  LORE_E_INVALID_ARGUMENT: EXIT_CODES.USER,
  LORE_E_CANCELLED: EXIT_CODES.USER,
  LORE_E_PARSE_FAILED: EXIT_CODES.BUILD,
  LORE_E_BUILD_VALIDATION: EXIT_CODES.BUILD,
  LORE_E_OBJECT_CORRUPT: EXIT_CODES.BUILD,
  LORE_E_LOCKFILE_DRIFT: EXIT_CODES.BUILD,
  LORE_E_STALE_SOURCES: EXIT_CODES.BUILD,
  LORE_E_LOCK_HELD: EXIT_CODES.CONCURRENCY,
  LORE_E_SQL_REJECTED: EXIT_CODES.USER,
  LORE_E_LIMIT_EXCEEDED: EXIT_CODES.USER,
  LORE_E_TARGET_NOT_CONFIGURED: EXIT_CODES.REMOTE,
  LORE_E_CAPABILITY_LOSS: EXIT_CODES.REMOTE,
  LORE_E_REMOTE_DEPLOY: EXIT_CODES.REMOTE,
  LORE_E_INTERNAL: EXIT_CODES.USER,
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_BY_CODE[code];
}
