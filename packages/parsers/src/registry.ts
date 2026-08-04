/**
 * Which file extensions Lorepack understands, as data.
 *
 * Enabling a format is a registry entry, not a code change, which is what keeps
 * "add a text format" a one-line pull request. Discovery consults this to decide what to
 * warn about; the parsers themselves are registered separately.
 */

export type ParserId = 'markdown' | 'text' | 'code' | 'html' | 'pdf-text' | 'docx' | 'csv' | 'xlsx';

export interface FormatEntry {
  readonly extensions: readonly string[];
  readonly mediaType: string;
  readonly parserId: ParserId;
  /** False for formats the architecture schedules for a later phase. */
  readonly available: boolean;
  /**
   * True when the parser reads **bytes** rather than decoded text.
   *
   * This is not a detail of the parser: it changes what fingerprinting is allowed to do.
   * That stage refuses any artifact whose bytes are not valid UTF-8 (#165), which is right
   * for a document and fatal for a container. Without this flag every `.docx` and `.xlsx`,
   * and every `.pdf` holding a compressed stream, was dropped before its parser ran, and the
   * user was told the file "appears to be binary" (#222). It did, and that was fine.
   */
  readonly readsBytes?: boolean;
}

export const FORMATS: readonly FormatEntry[] = [
  {
    extensions: ['.md', '.markdown', '.mdx'],
    mediaType: 'text/markdown',
    parserId: 'markdown',
    available: true,
  },
  {
    extensions: ['.txt', '.text', '.rst', '.adoc'],
    mediaType: 'text/plain',
    parserId: 'text',
    available: true,
  },
  {
    extensions: [
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.kt',
      '.rb',
      '.php',
      '.cs',
      '.swift',
      '.c',
      '.h',
      '.cc',
      '.cpp',
      '.hpp',
      '.sh',
      '.bash',
      '.zsh',
      '.sql',
      '.json',
      '.jsonc',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.cfg',
      '.conf',
      '.gradle',
      '.tf',
      '.dockerfile',
      '.graphql',
      '.proto',
    ],
    mediaType: 'text/plain',
    parserId: 'code',
    available: true,
  },
  { extensions: ['.html', '.htm'], mediaType: 'text/html', parserId: 'html', available: true },
  // Phase 5 formats still to come. Listed so discovery can say "supported later" rather than
  // "unsupported", which is a materially different message for a user with a PDF.
  {
    extensions: ['.pdf'],
    mediaType: 'application/pdf',
    parserId: 'pdf-text',
    available: true,
    readsBytes: true,
  },
  {
    extensions: ['.docx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    parserId: 'docx',
    available: true,
    readsBytes: true,
  },
  { extensions: ['.csv', '.tsv'], mediaType: 'text/csv', parserId: 'csv', available: true },
  {
    extensions: ['.xlsx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parserId: 'xlsx',
    available: true,
    readsBytes: true,
  },
];

const BY_EXTENSION = new Map<string, FormatEntry>(
  FORMATS.flatMap((entry) => entry.extensions.map((extension) => [extension, entry])),
);

/** Extensionless files that are conventionally plain text. */
const KNOWN_FILENAMES = new Map<string, FormatEntry>([
  ['dockerfile', FORMATS[2] as FormatEntry],
  ['makefile', FORMATS[2] as FormatEntry],
  ['readme', FORMATS[1] as FormatEntry],
  ['license', FORMATS[1] as FormatEntry],
]);

export function formatFor(filename: string): FormatEntry | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const entry = BY_EXTENSION.get(lower.slice(dot));
    if (entry !== undefined) return entry;
  }
  return KNOWN_FILENAMES.get(lower) ?? null;
}

export function isSupported(filename: string): boolean {
  return formatFor(filename)?.available === true;
}

/**
 * Whether this file's parser reads bytes, so text classification must not be applied to it.
 *
 * Asked by the fingerprint stage, which is the only stage that can wrongly exclude a file
 * before anything has tried to parse it.
 */
export function readsBytes(filename: string): boolean {
  return formatFor(filename)?.readsBytes === true;
}

/** Known but not implemented yet, which deserves a different message from unknown. */
export function isPlannedFormat(filename: string): boolean {
  const entry = formatFor(filename);
  return entry !== null && !entry.available;
}

export const SUPPORTED_EXTENSIONS: readonly string[] = FORMATS.filter(
  (entry) => entry.available,
).flatMap((entry) => entry.extensions);
