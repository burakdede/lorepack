import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import { asciiJson } from './config-file.js';

/**
 * Editing a JSON-with-comments configuration without losing the comments.
 *
 * `.vscode/mcp.json` is JSON only in the loose sense. VS Code's own schema for it declares
 * `allowComments: true` and `allowTrailingCommas: true`, so a user's file legitimately holds
 * `// the args took ages to get right`, and `JSON.parse` refuses the whole document over it.
 *
 * That puts this file in the same position as [`toml-config.ts`](./toml-config.ts) rather than
 * [`json-config.ts`](./json-config.ts): **parse to understand, edit minimally to write.** The
 * difference is that JSON has a standard tool for the minimal edit, `jsonc-parser`, which is
 * the one VS Code itself is built on. The decision, and the alternatives it closes off, are in
 * [`adr-toml-merge.md`](../../../docs/architecture/adr-toml-merge.md), which #81 widened from
 * TOML to any client configuration that can carry a comment.
 *
 * The bar is not hypothetical. `code --add-mcp` was measured on 1.132.0 deleting every comment
 * in the file, reformatting the whole document, and adding `"type": "stdio"` to a server the
 * user had configured by hand. Lorepack writing the file itself is only worth doing if it does
 * better than that, and the round-trip test is what proves it does.
 */

/** The machine-readable half of the ownership marker, which is a comment. */
export const JSONC_OWNERSHIP_PREFIX = '// x-lorepack ';

/** The human-readable half, so a person reading their own file knows what put it there. */
const OWNERSHIP_NOTE = '// Managed by Lorepack.';

export interface JsoncOwner {
  readonly projectRoot: string;
  readonly createdAt: string;
}

export interface JsoncConfig {
  /** The file without its byte order mark, which is what gets edited. */
  readonly text: string;
  readonly document: Record<string, unknown>;
  readonly formatting: FormattingOptions;
  readonly newline: '\n' | '\r\n';
  /** Restored on write. Windows editors save one, and dropping it is a diff nobody asked for. */
  readonly bom: boolean;
}

const BOM = '\ufeff';

const DEFAULT_FORMATTING: FormattingOptions = {
  // Tabs, because that is what VS Code writes when it creates the file itself. A file we
  // create should look like one the client created.
  insertSpaces: false,
  tabSize: 4,
  eol: '\n',
};

const EMPTY: JsoncConfig = {
  text: '',
  document: {},
  formatting: DEFAULT_FORMATTING,
  newline: '\n',
  bom: false,
};

/**
 * Reads a JSONC configuration, tolerating absence but never silently tolerating damage.
 *
 * The trap `jsonc-parser` sets here is worth naming: `parse` **does not throw**. Given
 * `{ "servers": ` it returns `{}` and reports the problem only through the errors array. A
 * caller that ignored it would see an empty configuration, conclude the file has no servers,
 * and write a fresh one over a file that merely had a missing brace.
 */
export function readJsoncConfig(path: string): JsoncConfig {
  if (!existsSync(path)) return EMPTY;

  // `jsonc-parser` reports a leading byte order mark as `InvalidSymbol at offset 0`, so a
  // file saved by a Windows editor was refused as broken (#581).
  const raw = readFileSync(path, 'utf8');
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  if (text.trim() === '') return { ...EMPTY, text, bom };

  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, unknown>
    | undefined;

  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new Error(
      `${path} is not valid JSON, so it will not be edited: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object, so it will not be edited.`);
  }

  return {
    text,
    document: parsed,
    formatting: formattingOf(text),
    newline: newlineOf(text),
    bom,
  };
}

const newlineOf = (text: string): '\n' | '\r\n' => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * The indentation the file already uses.
 *
 * Measured: editing a two-space file with tab settings reindents the *sibling* entries to tabs
 * and leaves the document mixed. Matching what is there costs one regular expression.
 */
export function formattingOf(text: string): FormattingOptions {
  const eol = newlineOf(text);
  for (const line of text.split('\n')) {
    const indent = /^([\t ]+)\S/.exec(line)?.[1];
    if (indent === undefined) continue;
    if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 4, eol };
    return { insertSpaces: true, tabSize: indent.length, eol };
  }
  return { ...DEFAULT_FORMATTING, eol };
}

/** The offset where the property's key begins, or undefined when it is not there. */
function keyOffsetOf(text: string, path: readonly (string | number)[]): number | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root === undefined) return undefined;
  const value = findNodeAtLocation(root, [...path]);
  const key = value?.parent?.children?.[0];
  return key?.offset;
}

/** Where the line containing an offset starts, so a comment can be put above it. */
const lineStartOf = (text: string, offset: number): number =>
  text.lastIndexOf('\n', offset - 1) + 1;

/**
 * Who created this entry, when Lorepack did.
 *
 * A comment rather than a key, and for a sharper reason than on the TOML side: VS Code's schema
 * for an stdio server declares **`additionalProperties: false`**. An `x-lorepack` key would put
 * a permanent red squiggle in the user's editor, on a file we wrote, forever. A comment is
 * explicitly allowed by the same schema.
 */
export function ownerOfEntry(
  text: string,
  path: readonly (string | number)[],
): JsoncOwner | undefined {
  const offset = keyOffsetOf(text, path);
  if (offset === undefined) return undefined;

  // Only the comment lines immediately above the property, and only ones we wrote. Walking
  // further would start claiming a note the user left above their own entry.
  const before = text.slice(0, lineStartOf(text, offset)).split('\n').reverse();
  for (const line of before) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith(JSONC_OWNERSHIP_PREFIX.trim())) {
      if (trimmed.startsWith(OWNERSHIP_NOTE)) continue;
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(JSONC_OWNERSHIP_PREFIX.trim().length)) as JsoncOwner;
      if (typeof parsed?.projectRoot === 'string') return parsed;
    } catch {
      // A marker we cannot read is not ours as far as removal is concerned, which is the safe
      // direction: leave it alone.
    }
    return undefined;
  }
  return undefined;
}

/** Removes the ownership comment above a property, so a rewrite never stacks a second one. */
function withoutOwnershipComment(text: string, path: readonly (string | number)[]): string {
  const offset = keyOffsetOf(text, path);
  if (offset === undefined) return text;

  let cut = lineStartOf(text, offset);
  for (;;) {
    if (cut === 0) break;
    const previous = lineStartOf(text, cut - 1);
    const line = text.slice(previous, cut - 1).trim();
    if (!line.startsWith(JSONC_OWNERSHIP_PREFIX.trim()) && !line.startsWith(OWNERSHIP_NOTE)) break;
    cut = previous;
  }
  return cut === lineStartOf(text, offset)
    ? text
    : text.slice(0, cut) + text.slice(lineStartOf(text, offset));
}

export interface OwnedEntryInput {
  readonly path: readonly (string | number)[];
  readonly projectRoot: string;
  readonly value: unknown;
  readonly createdAt?: string;
  /** The command that takes it back, named in the comment for whoever reads the file. */
  readonly removeWith: string;
}

/**
 * Sets one entry and marks it as ours, leaving every other byte alone.
 *
 * Idempotent by construction: the ownership comment is stripped before the edit and written
 * again after it, and `jsonc-parser` produces an identical document for an identical value.
 */
export function withOwnedEntry(config: JsoncConfig, input: OwnedEntryInput): string {
  const stripped = withoutOwnershipComment(config.text, input.path);
  const edited = applyEdits(
    stripped,
    modify(stripped, [...input.path], input.value, { formattingOptions: config.formatting }),
  );

  const offset = keyOffsetOf(edited, input.path);
  if (offset === undefined) return edited;

  const start = lineStartOf(edited, offset);
  const indent = /^[\t ]*/.exec(edited.slice(start))?.[0] ?? '';
  const marker: JsoncOwner = {
    projectRoot: input.projectRoot,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const comment = [
    `${indent}${OWNERSHIP_NOTE} \`${input.removeWith}\` removes exactly this entry.`,
    `${indent}${JSONC_OWNERSHIP_PREFIX}${asciiJson(marker)}`,
    '',
  ].join(config.newline);

  const result = edited.slice(0, start) + comment + indent + edited.slice(start + indent.length);
  assertOnlyEntryChanged(result, config.document, input.path, input.value);
  return result;
}

/** The document with `path` set to `value`, or without it when `value` is undefined. */
function withValueAt(
  document: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const container =
    typeof document === 'object' && document !== null ? (document as Record<string, unknown>) : {};
  const copy: Record<string, unknown> = { ...container };
  const next = withValueAt(container[head], rest, value);
  if (next === undefined) delete copy[head];
  else copy[head] = next;
  return copy;
}

/**
 * Parses the edited text and checks that only our entry changed.
 *
 * The edit is a minimal text splice, so its result is checked the same way as the TOML side's:
 * a result that does not parse, or parses to anything but the original with our one entry
 * changed, is refused before it reaches the disk.
 */
function assertOnlyEntryChanged(
  edited: string,
  original: Record<string, unknown>,
  path: readonly (string | number)[],
  value: unknown,
): void {
  const errors: ParseError[] = [];
  const parsed = parse(edited, errors, { allowTrailingComma: true, disallowComments: false });
  const plain = (data: unknown): unknown => JSON.parse(JSON.stringify(data ?? null));
  if (
    errors.length > 0 ||
    !isDeepStrictEqual(plain(parsed), plain(withValueAt(original, path, value)))
  ) {
    throw new Error(
      'Editing this file would change more than the Lorepack entry, so it was left as it is. Run `lorepack connect vscode --snippet` and edit it by hand.',
    );
  }
}

/**
 * Removes an entry, and only if Lorepack created it.
 *
 * Returns whether anything was removed, so the caller can say "nothing to do" rather than
 * claiming to have disconnected something it left in place.
 */
export function withoutOwnedEntry(
  config: JsoncConfig,
  path: readonly (string | number)[],
  projectRoot?: string,
): { readonly text: string; readonly removed: boolean; readonly owner?: JsoncOwner } {
  const owner = ownerOfEntry(config.text, path);
  if (owner === undefined) return { text: config.text, removed: false };
  if (projectRoot !== undefined && owner.projectRoot !== projectRoot) {
    return { text: config.text, removed: false, owner };
  }

  const stripped = withoutOwnershipComment(config.text, path);
  const text = applyEdits(
    stripped,
    modify(stripped, [...path], undefined, { formattingOptions: config.formatting }),
  );
  assertOnlyEntryChanged(text, config.document, path, undefined);
  return { text, removed: true, owner };
}
