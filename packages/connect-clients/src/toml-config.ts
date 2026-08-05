import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';

/**
 * Editing someone else's TOML configuration without losing a byte of it.
 *
 * This is the TOML half of [`json-config.ts`](./json-config.ts), and it exists because the
 * two formats fail differently. A JSON configuration can be parsed, merged and re-serialized
 * with nothing lost, because JSON carries no comments and no meaningful ordering. A TOML
 * configuration cannot: it is a file people write by hand, with comments explaining why a
 * sandbox setting is the way it is, and **no JavaScript TOML library preserves those across a
 * round trip**. All three candidates were installed and measured, and all three drop every
 * comment (see [`adr-toml-merge.md`](../../../docs/architecture/adr-toml-merge.md)).
 *
 * So the strategy is different in one specific way: **parse to understand, splice to write.**
 * The parser is the authority on whether the file is valid and what is in it, and it decides
 * whether we are allowed to touch the file at all. The write then replaces only the lines of
 * our own table, byte for byte, and every other line in the file survives exactly as typed.
 *
 * Everything else is the same as the JSON side and for the same reasons: back up first, write
 * to a sibling and rename, and never remove an entry we did not create.
 */

/** The byte order mark a Windows editor leaves, which `smol-toml` refuses to parse. */
const BOM = '\ufeff';

/** The machine-readable half of the ownership marker, which is a comment. */
export const TOML_OWNERSHIP_PREFIX = '# x-lorepack ';

/** The human-readable half, so a person reading their own file knows what put it there. */
const OWNERSHIP_NOTE = '# Managed by Lorepack.';

export interface TomlOwner {
  readonly projectRoot: string;
  readonly createdAt: string;
}

export interface TomlConfig {
  /** The file exactly as it is on disk, which is what gets spliced. */
  readonly text: string;
  /** The parsed value, which is what decides whether the file may be edited. */
  readonly document: Record<string, unknown>;
  /** Preserved on write, because rewriting a file's line endings is a diff nobody asked for. */
  readonly newline: '\n' | '\r\n';
  readonly bom: boolean;
}

const EMPTY: TomlConfig = { text: '', document: {}, newline: '\n', bom: false };

/**
 * Reads a TOML configuration, tolerating absence but never silently tolerating damage.
 *
 * A file that does not parse is refused rather than replaced, exactly as on the JSON side.
 * Measured behaviour worth knowing: `smol-toml` rejects a leading byte order mark, which real
 * files written by Windows editors carry, so the mark is stripped before parsing and restored
 * on write rather than being reported to the user as a broken configuration.
 */
export function readTomlConfig(path: string): TomlConfig {
  if (!existsSync(path)) return EMPTY;

  const raw = readFileSync(path, 'utf8');
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  if (text.trim() === '') return { ...EMPTY, text, bom };

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  try {
    const parsed = parse(text) as Record<string, unknown>;
    return { text, document: parsed, newline, bom };
  } catch (cause) {
    throw new Error(
      `${path} is not valid TOML, so it will not be edited: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Writes atomically to a sibling and renames, so an interrupted run leaves the old file. */
export function writeTextAtomically(path: string, text: string, bom = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${process.pid}.tmp`);
  writeFileSync(temporary, `${bom ? BOM : ''}${text}`, 'utf8');
  renameSync(temporary, path);
}

/**
 * The key path a table header declares, or undefined when the line is not a header.
 *
 * Tolerant on purpose, because TOML allows `[ mcp_servers . "odd name" ]` and a person's file
 * is not obliged to look like ours. An array-of-tables header (`[[…]]`) returns undefined:
 * it is a header, but not one that can hold a server table, and treating it as one is how a
 * splice lands in the wrong place.
 */
export function tableHeaderPath(line: string): readonly string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return undefined;

  const close = trimmed.lastIndexOf(']');
  if (close <= 0) return undefined;
  // Anything after the bracket must be a comment; a value there is not a header at all.
  const tail = trimmed.slice(close + 1).trim();
  if (tail !== '' && !tail.startsWith('#')) return undefined;

  const segments: string[] = [];
  let rest = trimmed.slice(1, close).trim();
  while (rest !== '') {
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0] as string;
      const end = rest.indexOf(quote, 1);
      if (end === -1) return undefined;
      segments.push(rest.slice(1, end));
      rest = rest.slice(end + 1).trim();
    } else {
      const end = rest.indexOf('.');
      const bare = (end === -1 ? rest : rest.slice(0, end)).trim();
      if (bare === '' || !/^[A-Za-z0-9_-]+$/.test(bare)) return undefined;
      segments.push(bare);
      rest = end === -1 ? '' : rest.slice(end + 1).trim();
      continue;
    }
    if (rest.startsWith('.')) rest = rest.slice(1).trim();
    else if (rest !== '') return undefined;
  }

  return segments.length === 0 ? undefined : segments;
}

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

interface Span {
  /** The first line of the block, including any ownership comment Lorepack wrote. */
  readonly start: number;
  /** One past the last line, which is the next header that is not part of this table. */
  readonly end: number;
}

/**
 * The lines a table occupies, including its own sub-tables.
 *
 * `[mcp_servers.lorepack.env]` belongs to `[mcp_servers.lorepack]` and must move with it,
 * which is why the end is the next header that is *not* a descendant rather than simply the
 * next header.
 */
export function tableSpan(text: string, path: readonly string[]): Span | undefined {
  const lines = text.split('\n');
  let start = -1;

  for (const [index, line] of lines.entries()) {
    const header = tableHeaderPath(line);
    if (header === undefined) continue;

    if (start === -1) {
      if (header.length === path.length && startsWith(header, path)) start = index;
      continue;
    }
    if (!startsWith(header, path)) return { start: withOwnedComments(lines, start), end: index };
  }

  if (start === -1) return undefined;
  return { start: withOwnedComments(lines, start), end: lines.length };
}

/** Extends a span upward over the comment lines Lorepack itself wrote, and no others. */
function withOwnedComments(lines: readonly string[], start: number): number {
  let first = start;
  while (first > 0) {
    const above = (lines[first - 1] ?? '').trim();
    if (!above.startsWith(TOML_OWNERSHIP_PREFIX.trim()) && !above.startsWith(OWNERSHIP_NOTE)) break;
    first -= 1;
  }
  return first;
}

/**
 * Who created this table, when Lorepack did.
 *
 * ## Why a comment and not a key
 *
 * The JSON adapters mark ownership with an `x-lorepack` key inside the entry, and Codex 0.146
 * was measured tolerating exactly that. It is still not what is written here, because the two
 * failure modes are not comparable. A marker Codex one day refuses is a configuration that no
 * longer loads at all, and the user's whole client breaks with our name on the change. A
 * comment cannot do that in any version, ever: the worst it can do is be lost to a
 * reformatting tool, after which `disconnect` leaves our entry in place and the user removes
 * five lines by hand. Architecture 24.8 is about the first kind of failure.
 */
export function ownerOfTable(text: string, path: readonly string[]): TomlOwner | undefined {
  const span = tableSpan(text, path);
  if (span === undefined) return undefined;

  for (const line of text.split('\n').slice(span.start)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    if (!trimmed.startsWith(TOML_OWNERSHIP_PREFIX.trim())) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(TOML_OWNERSHIP_PREFIX.trim().length)) as TomlOwner;
      if (typeof parsed?.projectRoot === 'string') return parsed;
    } catch {
      // A marker we cannot read is not ours as far as removal is concerned, which is the
      // safe direction: leave it alone.
    }
  }
  return undefined;
}

/** TOML basic-string escaping, which is what makes a Windows path safe to write. */
export function tomlString(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += character;
  }
  return `"${out}"`;
}

export interface OwnedTableInput {
  readonly path: readonly string[];
  readonly projectRoot: string;
  /** String and string-array values only, which is the whole shape a server entry needs. */
  readonly values: Readonly<Record<string, string | readonly string[]>>;
  readonly createdAt?: string;
}

/** The exact text Lorepack writes, ownership comment first, with no trailing blank line. */
export function renderOwnedTable(input: OwnedTableInput): string {
  const marker: TomlOwner = {
    projectRoot: input.projectRoot,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  const lines = [
    `${OWNERSHIP_NOTE} \`lore disconnect codex\` removes exactly this block.`,
    `${TOML_OWNERSHIP_PREFIX}${JSON.stringify(marker)}`,
    `[${input.path.map(renderKey).join('.')}]`,
  ];
  for (const [key, value] of Object.entries(input.values)) {
    lines.push(
      `${renderKey(key)} = ${
        typeof value === 'string' ? tomlString(value) : `[${value.map(tomlString).join(', ')}]`
      }`,
    );
  }
  return lines.join('\n');
}

const renderKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

/**
 * Replaces the table's lines, or appends it, leaving every other line exactly as it was.
 *
 * Idempotent by construction: a second call finds the block the first one wrote and replaces
 * the same span, so re-running `lore connect` to fix a stale path never accumulates anything.
 */
export function withTomlTable(config: TomlConfig, path: readonly string[], block: string): string {
  const body = config.text.replace(/\r\n/g, '\n');
  const rendered = block.replace(/\r\n/g, '\n');
  const span = tableSpan(body, path);

  let merged: string;
  if (span === undefined) {
    const before = body.trimEnd();
    merged = before === '' ? `${rendered}\n` : `${before}\n\n${rendered}\n`;
  } else {
    const lines = body.split('\n');
    const after = lines.slice(span.end);
    // The blank line before the next header is re-emitted rather than preserved, because the
    // replaced span absorbed it. Doing it here is what keeps a second run byte-identical.
    const tail = after.length === 0 ? [''] : ['', ...after];
    merged = [...lines.slice(0, span.start), ...rendered.split('\n'), ...tail].join('\n');
  }

  return config.newline === '\r\n' ? merged.replace(/\n/g, '\r\n') : merged;
}

/**
 * Removes a table, and only if Lorepack created it.
 *
 * Returns whether anything was removed, so the caller can say "nothing to do" rather than
 * claiming to have disconnected something it left in place.
 */
export function withoutTomlTable(
  config: TomlConfig,
  path: readonly string[],
  projectRoot?: string,
): { readonly text: string; readonly removed: boolean } {
  const body = config.text.replace(/\r\n/g, '\n');
  const span = tableSpan(body, path);
  if (span === undefined) return { text: config.text, removed: false };

  const owner = ownerOfTable(body, path);
  // Present but not ours, or ours from a different project: leaving it is the only
  // defensible choice. Someone who wrote this table by hand did not ask us to delete it.
  if (owner === undefined) return { text: config.text, removed: false };
  if (projectRoot !== undefined && owner.projectRoot !== projectRoot) {
    return { text: config.text, removed: false };
  }

  const lines = body.split('\n');
  const kept = [...lines.slice(0, span.start), ...lines.slice(span.end)];
  const collapsed = `${kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
  const text = collapsed === '\n' ? '' : collapsed;

  return { text: config.newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text, removed: true };
}
