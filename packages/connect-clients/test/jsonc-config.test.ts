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
  bom: false,
});

const owned = (text: string, projectRoot = '/p'): string =>
  withOwnedEntry(config(text), {
    path: PATH,
    projectRoot,
    value: { type: 'stdio', command: 'lorepack', args: ['mcp'] },
    createdAt: '2026-08-05T00:00:00.000Z',
    removeWith: 'lorepack disconnect vscode',
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
    expect(parse(after).servers.lorepack.command).toBe('lorepack');
  });

  it('is byte-identical when applied twice, and never stacks a second marker', () => {
    const once = owned(FOREIGN);
    const twice = owned(once);

    expect(twice).toBe(once);
    expect(twice.split('x-lorepack')).toHaveLength(2);
  });

  it('writes into an empty file', () => {
    expect(parse(owned('')).servers.lorepack.command).toBe('lorepack');
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

describe('what a Windows editor writes, and paths a comment cannot hold raw (#581)', () => {
  it('reads a file with a byte order mark and CRLF endings, and keeps both', () => {
    const path = join(directory, 'mcp.json');
    writeFileSync(path, `\ufeff${FOREIGN.replace(/\n/g, '\r\n')}`, 'utf8');

    const read = readJsoncConfig(path);
    expect(read.bom).toBe(true);
    expect(read.newline).toBe('\r\n');
    expect(read.text.startsWith('{')).toBe(true);

    const added = owned(read.text);
    const { text } = withoutOwnedEntry({ ...read, text: added }, PATH);
    expect(text).toBe(read.text);
  });

  it('escapes a project path into a plain ASCII marker, and reads it back', () => {
    const root = 'C:\\Users\\me\\del\u007fproj\u2028caf\u00e9';
    const written = owned(FOREIGN, root);

    const marker = written.split('\n').find((line) => line.includes('// x-lorepack'));
    expect(marker?.trim()).toMatch(/^[\x20-\x7e]*$/);
    expect(ownerOfEntry(written, PATH)?.projectRoot).toBe(root);
  });

  // Each holds a multi-line object for our entry to join. A neighbour written on one line is
  // expanded when ours is added beside it, the caveat `docs/integrations/vscode.md` records.
  const FIXTURES = [
    FOREIGN,
    FOREIGN.replace(/\n/g, '\r\n'),
    '{\n  // two spaces\n  "servers": {\n    "a": {\n      "command": "a"\n    },\n    "b": {\n      "command": "b"\n    }\n  },\n  "inputs": []\n}\n',
    '{\n\t"inputs": [],\n\t"servers": {\n\t\t"a": {\n\t\t\t"command": "a"\n\t\t}\n\t}\n}',
  ];

  it.each(FIXTURES.map((text) => [JSON.stringify(text), text]))(
    'connect then disconnect is byte-identical for %s',
    (_name, before) => {
      const { text, removed } = withoutOwnedEntry(config(owned(before)), PATH, '/p');

      expect(removed).toBe(true);
      expect(text).toBe(before);
    },
  );
});

describe('exact config bytes, issue581', () => {
  const originals = [
    ['inline neighbour', '{"servers":{"a":{"command":"a"}},"inputs":[]}'],
    [
      'trailing comment',
      '{\n  "servers": {\n    "a": { "command": "a" }, // trailing\n  },\n  "inputs": []\n}\n',
    ],
    ['empty servers', '{"servers": {}}'],
    ['empty servers with whitespace', '{\n  "servers": { \t }\n}\n'],
  ] as const;
  const cases = originals
    .flatMap(([name, original]) => [
      { name: `${name}, original`, text: original },
      {
        name: `${name}, CRLF`,
        text: original.includes('\n') ? original.replaceAll('\n', '\r\n') : `${original}\r\n`,
      },
    ])
    .flatMap((fixture) => [
      fixture,
      { name: `${fixture.name}, BOM`, text: `\ufeff${fixture.text}` },
    ]);

  it.each(cases)('restores exact bytes and values for $name', ({ text: before }) => {
    const file = join(directory, 'mcp.json');
    writeFileSync(file, before);
    const initial = readJsoncConfig(file);
    const connected = withOwnedEntry(initial, {
      path: PATH,
      projectRoot: '/p',
      value: { type: 'stdio', command: 'lorepack', args: ['mcp'] },
      createdAt: '2026-08-05T00:00:00.000Z',
      removeWith: 'lorepack disconnect vscode',
    });
    const errors: import('jsonc-parser').ParseError[] = [];
    const added = parse(connected, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(added).toEqual({
      ...initial.document,
      servers: {
        ...(initial.document.servers as Record<string, unknown>),
        lorepack: { type: 'stdio', command: 'lorepack', args: ['mcp'] },
      },
    });
    expect(ownerOfEntry(connected, ['servers', 'a'])).toBeUndefined();
    writeFileSync(file, `${initial.bom ? '\ufeff' : ''}${connected}`);
    const during = readJsoncConfig(file);
    const removed = withoutOwnedEntry(during, PATH, '/p');
    expect(removed.removed).toBe(true);
    const parsedAfter = parse(removed.text, [], { allowTrailingComma: true });
    expect(parsedAfter).toEqual(initial.document);
    const after = Buffer.from(`${during.bom ? '\ufeff' : ''}${removed.text}`, 'utf8');
    expect(after).toEqual(Buffer.from(before, 'utf8'));
  });
});

it('keeps multiple raw entry owners independent during updates and removals, issue581', () => {
  const before = '{"servers":{"a":{"command":"a"}},"inputs":[]}';
  const otherPath = ['servers', 'another'];
  const both = withOwnedEntry(config(owned(before)), {
    path: otherPath,
    projectRoot: '/other',
    value: { command: 'other' },
    createdAt: '2026-08-05T00:00:00.000Z',
    removeWith: 'lorepack disconnect vscode',
  });
  const updated = owned(both);
  expect(ownerOfEntry(updated, PATH)?.projectRoot).toBe('/p');
  expect(ownerOfEntry(updated, otherPath)?.projectRoot).toBe('/other');
  expect(ownerOfEntry(updated, ['servers', 'a'])).toBeUndefined();
  expect(ownerOfEntry(updated, ['inputs'])).toBeUndefined();
  expect(owned(updated)).toBe(updated);
  const first = withoutOwnedEntry(config(updated), PATH, '/p');
  expect(first.removed).toBe(true);
  expect(ownerOfEntry(first.text, otherPath)?.projectRoot).toBe('/other');
  const last = withoutOwnedEntry(config(first.text), otherPath, '/other');
  expect(last.removed).toBe(true);
  expect(last.text).toBe(before);
});
it('retains support for existing property-local ownership markers, issue581', () => {
  const text =
    '{"servers":{"a":{"command":"a"},\n// Managed by Lorepack.\n// x-lorepack {"projectRoot":"/p","createdAt":"2026-08-05T00:00:00.000Z"}\n"lorepack":{"command":"lorepack"}},"inputs":[]}';
  expect(ownerOfEntry(text, PATH)).toEqual({
    projectRoot: '/p',
    createdAt: '2026-08-05T00:00:00.000Z',
  });
  const removed = withoutOwnedEntry(config(text), PATH, '/p');
  expect(removed.removed).toBe(true);
  expect(parse(removed.text)).toEqual({ servers: { a: { command: 'a' } }, inputs: [] });
  expect(removed.text).toContain('"a":{"command":"a"}');
});

it('keeps unrelated edits made after connecting byte-for-byte, issue581', () => {
  const before = '{"servers":{"a":{"command":"a"}},"inputs":[]}';
  const changed = owned(before).replace('"command":"a"', '"command":"updated"');
  const removed = withoutOwnedEntry(config(changed), PATH, '/p');
  expect(removed.removed).toBe(true);
  expect(removed.text).toBe(before.replace('"command":"a"', '"command":"updated"'));
});
it.each([null, 'servers.lorepack', ['servers', 'other'], { path: ['servers', 'lorepack'] }])(
  'leaves an entry with invalid or differently bound ownership untouched, issue581: %j',
  (entryPath) => {
    const connected = owned(FOREIGN);
    expect(connected).toContain('"entryPath":["servers","lorepack"]');
    const text = connected.replace(
      '"entryPath":["servers","lorepack"]',
      `"entryPath":${JSON.stringify(entryPath)}`,
    );
    expect(ownerOfEntry(text, PATH)).toBeUndefined();
    expect(withoutOwnedEntry(config(text), PATH, '/p')).toEqual({ text, removed: false });
  },
);
it.each(['', ' \r\n\t', '{}', '{"inputs":[]}'])(
  'retains the existing empty-container lifecycle for a file without servers, issue581: %j',
  (before) => {
    const file = join(directory, 'mcp.json');
    writeFileSync(file, before);
    const initial = readJsoncConfig(file);
    const added = withOwnedEntry(initial, {
      path: PATH,
      projectRoot: '/p',
      value: { command: 'lorepack' },
      removeWith: 'lorepack disconnect vscode',
    });
    const removed = withoutOwnedEntry(config(added), PATH, '/p');
    expect(removed.removed).toBe(true);
    expect(parse(removed.text)).toEqual({ ...initial.document, servers: {} });
    if (before.trim() === '') expect(removed.text.endsWith(before)).toBe(true);
    if ('inputs' in initial.document) expect(removed.text).toContain('"inputs":[]');
  },
);

it('keeps a foreign server subtree intact while connected, issue581', () => {
  const subtree =
    '\t\t"theirs": {\n\t\t\t"command": "their-binary",\n\t\t\t"args": ["--serve"] // do not change\n\t\t}';
  expect(FOREIGN).toContain(subtree);
  expect(owned(FOREIGN)).toContain(subtree);
});
it('keeps a trailing comment beside its original inline neighbour while connected, issue581', () => {
  const line = '    "a": { "command": "a" }, // trailing';
  const before = `{\n  "servers": {\n${line}\n  },\n  "inputs": []\n}\n`;
  expect(owned(before)).toContain(line);
});

it.each([false, true])(
  'restores an empty parent after either owned removal order, issue581: %s',
  (reverse) => {
    const before = '{"servers": { \t },"inputs":[]}';
    const otherPath = ['servers', 'another'];
    const both = withOwnedEntry(config(owned(before)), {
      path: otherPath,
      projectRoot: '/other',
      value: { command: 'other' },
      createdAt: '2026-08-05T00:00:00.000Z',
      removeWith: 'lorepack disconnect vscode',
    });
    const paths = reverse ? [otherPath, PATH] : [PATH, otherPath];
    const first = withoutOwnedEntry(config(both), paths[0] as string[]);
    const last = withoutOwnedEntry(config(first.text), paths[1] as string[]);
    expect(first.removed).toBe(true);
    expect(last.removed).toBe(true);
    expect(last.text).toBe(before);
  },
);

it('preserves Unicode neighbours at parser offsets, issue581', () => {
  const before = '{"note":"資料🌍","servers":{"a":{"command":"é"}},"inputs":[]}';
  const connected = owned(before);
  expect(connected).toContain('"a":{"command":"é"}');
  expect(withoutOwnedEntry(config(connected), PATH, '/p').text).toBe(before);
});
