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
  { extensions: ['.pdf'], mediaType: 'application/pdf', parserId: 'pdf-text', available: false },
  {
    extensions: ['.docx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    parserId: 'docx',
    available: false,
  },
  { extensions: ['.csv'], mediaType: 'text/csv', parserId: 'csv', available: false },
  {
    extensions: ['.xlsx'],
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parserId: 'xlsx',
    available: false,
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

/** Known but not implemented yet, which deserves a different message from unknown. */
export function isPlannedFormat(filename: string): boolean {
  const entry = formatFor(filename);
  return entry !== null && !entry.available;
}

export const SUPPORTED_EXTENSIONS: readonly string[] = FORMATS.filter(
  (entry) => entry.available,
).flatMap((entry) => entry.extensions);
