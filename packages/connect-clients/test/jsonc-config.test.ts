import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formattingOf,
  ownerOfEntry,
  readJsoncConfig,
  withOwnedEntry,
  withoutOwnedEntry,
} from '../src/jsonc-config.js';

/**
 * The minimal edit, which is the part that can silently damage someone's file.
 *
 * The adapter tests prove VS Code ends up configured. These prove the narrower and more
 * dangerous claim underneath: that **only our own entry moves**. Every case is a shape a real
 * hand-written `.vscode/mcp.json` takes, and getting any of them wrong produces a valid file
 * that has quietly lost something.
 */

let directory: string;

const PATH = ['servers', 'lorepack'];

const config = (text: string) => ({
  text,
  document: parse(text, [], { allowTrailingComma: true }) as Record<string, unknown>,
  formatting: formattingOf(text),
  newline: text.includes('\r\n') ? ('\r\n' as const) : ('\n' as const),
});

const owned = (text: string, projectRoot = '/p'): string =>
  withOwnedEntry(config(text), {
    path: PATH,
    projectRoot,
    value: { type: 'stdio', command: 'lore', args: ['mcp'] },
    createdAt: '2026-08-05T00:00:00.000Z',
    removeWith: 'lore disconnect vscode',
  });

const FOREIGN = `{
\t// Their notes server.
\t"servers": {
\t\t"theirs": {
\t\t\t"command": "their-binary",
\t\t\t"args": ["--serve"] // do not change
\t\t}
\t},
\t"inputs": []
}
`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-jsonc-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('editing', () => {
  it('adds an entry and leaves every comment and sibling exactly as written', () => {
    const after = owned(FOREIGN);

    expect(after).toContain('// Their notes server.');
    expect(after).toContain('"args": ["--serve"] // do not change');
    expect(after).toContain('"inputs": []');
    expect(parse(after).servers.lorepack.command).toBe('lore');
  });

  it('is byte-identical when applied twice, and never stacks a second marker', () => {
    const once = owned(FOREIGN);
    const twice = owned(once);

    expect(twice).toBe(once);
    expect(twice.split('x-lorepack')).toHaveLength(2);
  });

  it('writes into an empty file', () => {
    expect(parse(owned('')).servers.lorepack.command).toBe('lore');
  });

  it('matches the indentation the file already uses', () => {
    const twoSpace = '{\n  "servers": {\n    "theirs": {\n      "command": "x"\n    }\n  }\n}\n';
    expect(owned(twoSpace)).not.toContain('\t');
    expect(formattingOf(twoSpace)).toMatchObject({ insertSpaces: true, tabSize: 2 });
    expect(formattingOf(FOREIGN)).toMatchObject({ insertSpaces: false });
  });

  it('keeps CRLF endings rather than rewriting the whole file', () => {
    const after = owned(FOREIGN.replace(/\n/g, '\r\n'));

    // Converting a Windows user's line endings shows up as a whole-file diff in their next
    // commit, over a change that touched one entry.
    expect(after).not.toMatch(/[^\r]\n/);
  });
});

describe('removing', () => {
  it('restores the file byte for byte', () => {
    const { text, removed } = withoutOwnedEntry(config(owned(FOREIGN)), PATH);

    expect(removed).toBe(true);
    expect(text).toBe(FOREIGN);
  });

  it('refuses an entry Lorepack did not write', () => {
    const theirs = '{\n\t"servers": {\n\t\t"lorepack": { "command": "theirs" }\n\t}\n}\n';
    const { text, removed } = withoutOwnedEntry(config(theirs), PATH);

    // No ownership comment, so it is not ours. Removing it because the name matched is the
    // corruption the marker exists to prevent.
    expect(removed).toBe(false);
    expect(text).toBe(theirs);
  });

  it("refuses an entry another project's Lorepack wrote", () => {
    const { removed } = withoutOwnedEntry(config(owned(FOREIGN, '/elsewhere')), PATH, '/here');
    expect(removed).toBe(false);
  });
});

describe('ownership, which is a comment on purpose', () => {
  /**
   * The property that broke on Windows in #81: the marker has to return the project root
   * **exactly** as it was given. The bug was not here, it was an adapter deriving the root by
   * taking a path apart, which turned `C:\\Users\\me\\p` into `C:/Users/me/p` and made every
   * ownership check answer "not ours". Asserting the exact string keeps that honest.
   */
  it('returns the project root byte for byte, including a Windows path', () => {
    const windows = 'C:\\Users\\me\\a "project"';
    expect(ownerOfEntry(owned(FOREIGN, windows), PATH)?.projectRoot).toBe(windows);
  });

  it('is invisible to the client, because a comment always is', () => {
    // The reason it is not a key: VS Code's schema for a server is
    // `additionalProperties: false`, so a key would be a permanent error in the user's editor.
    expect(Object.keys(parse(owned(FOREIGN)).servers.lorepack)).toEqual([
      'type',
      'command',
      'args',
    ]);
  });

  it('claims nothing for an entry with no marker, or a damaged one', () => {
    expect(ownerOfEntry('{ "servers": { "lorepack": { "command": "x" } } }', PATH)).toBeUndefined();
    expect(
      ownerOfEntry('{\n"servers": {\n// x-lorepack not-json\n"lorepack": {}\n}\n}', PATH),
    ).toBeUndefined();
  });

  it('does not claim an entry a comment of the user\u2019s happens to sit above', () => {
    const theirs =
      '{\n\t"servers": {\n\t\t// mine, do not touch\n\t\t"lorepack": { "command": "x" }\n\t}\n}\n';
    expect(ownerOfEntry(theirs, PATH)).toBeUndefined();
  });
});

describe('reading a file', () => {
  /**
   * The trap `jsonc-parser` sets: `parse` does not throw. Given `{ "servers": ` it returns
   * `{}` and reports the damage only through an errors array, so a caller that ignored it
   * would decide the file has no servers and write a fresh one over a missing brace.
   */
  it('refuses a damaged file rather than reading it as empty', () => {
    const path = join(directory, 'mcp.json');
    writeFileSync(path, '{\n\t"servers": \n', 'utf8');

    expect(() => readJsoncConfig(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{\n\t"servers": \n');
  });

  it('accepts the comments and trailing commas VS Code accepts', () => {
    const path = join(directory, 'mcp.json');
    writeFileSync(
      path,
      '{\n\t// fine\n\t"servers": {\n\t\t"a": { "command": "x" },\n\t},\n}\n',
      'utf8',
    );

    // VS Code's own schema sets `allowComments` and `allowTrailingCommas`, so refusing this
    // would be us being stricter than the client we are configuring.
    expect(Object.keys(readJsoncConfig(path).document.servers as object)).toEqual(['a']);
  });

  it('refuses a document that is not an object', () => {
    const path = join(directory, 'mcp.json');
    writeFileSync(path, '[1, 2]\n', 'utf8');
    expect(() => readJsoncConfig(path)).toThrow(/not a JSON object/);
  });

  it('treats a missing or blank file as an empty configuration', () => {
    expect(readJsoncConfig(join(directory, 'nope.json')).document).toEqual({});
    const blank = join(directory, 'blank.json');
    writeFileSync(blank, '\n\n', 'utf8');
    expect(readJsoncConfig(blank).document).toEqual({});
  });
});
