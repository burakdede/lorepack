import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ownerOfTable,
  readTomlConfig,
  renderOwnedTable,
  tableHeaderPath,
  tableSpan,
  tomlString,
  withoutTomlTable,
  withTomlTable,
  writeTextAtomically,
} from '../src/toml-config.js';

/**
 * The splice, which is the part that can silently destroy someone's file.
 *
 * The adapter tests prove Codex ends up configured. These prove the much narrower and much
 * more dangerous claim underneath: that **only our own lines move**. Every case here is a
 * shape a real hand-written `config.toml` takes, and a splice that gets any of them wrong
 * produces a valid file that has quietly lost something.
 */

let directory: string;

const PATH = ['mcp_servers', 'lorepack'];

const block = (root = '/p'): string =>
  renderOwnedTable({
    path: PATH,
    projectRoot: root,
    values: { command: 'lore', args: ['mcp', '--project', root], cwd: root },
    createdAt: '2026-08-05T00:00:00.000Z',
  });

const config = (text: string) => ({
  text,
  document: parse(text) as Record<string, unknown>,
  newline: text.includes('\r\n') ? ('\r\n' as const) : ('\n' as const),
  bom: false,
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-toml-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('reading a header line', () => {
  it('reads the ordinary form', () => {
    expect(tableHeaderPath('[mcp_servers.lorepack]')).toEqual(['mcp_servers', 'lorepack']);
  });

  it('reads the forms TOML allows but nobody writes on purpose', () => {
    expect(tableHeaderPath('[ mcp_servers . lorepack ]')).toEqual(['mcp_servers', 'lorepack']);
    expect(tableHeaderPath('["mcp_servers".lorepack] # a comment')).toEqual([
      'mcp_servers',
      'lorepack',
    ]);
    expect(tableHeaderPath('[mcp_servers."odd.name"]')).toEqual(['mcp_servers', 'odd.name']);
    expect(tableHeaderPath('[mcp_servers.my-server]')).toEqual(['mcp_servers', 'my-server']);
  });

  it('is not fooled by something that merely starts with a bracket', () => {
    // An array of tables is a header, and not one a server table can live in. Treating it as
    // one is how a splice lands in the wrong place.
    expect(tableHeaderPath('[[mcp_servers]]')).toBeUndefined();
    expect(tableHeaderPath('args = ["mcp_servers.lorepack"]')).toBeUndefined();
    expect(tableHeaderPath('[unclosed')).toBeUndefined();
    expect(tableHeaderPath('# [mcp_servers.lorepack]')).toBeUndefined();
  });
});

describe('finding the lines a table occupies', () => {
  it('runs from the header to the next unrelated header', () => {
    const text = 'a = 1\n\n[mcp_servers.lorepack]\ncommand = "lore"\n\n[other]\nb = 2\n';
    const span = tableSpan(text, PATH);

    expect(text.split('\n').slice(span?.start, span?.end).join('\n')).toBe(
      '[mcp_servers.lorepack]\ncommand = "lore"\n',
    );
  });

  it('carries the table\u2019s own sub-tables with it', () => {
    const text =
      '[mcp_servers.lorepack]\ncommand = "lore"\n\n[mcp_servers.lorepack.env]\nA = "1"\n\n[other]\nb = 2\n';
    const span = tableSpan(text, PATH);

    // `[mcp_servers.lorepack.env]` belongs to the entry. Leaving it behind on removal would
    // strand a fragment of our configuration in their file.
    expect(text.split('\n').slice(span?.start, span?.end).join('\n')).toContain(
      '[mcp_servers.lorepack.env]',
    );
  });

  it('does not confuse a sibling whose name starts the same way', () => {
    const text = '[mcp_servers.lorepack-other]\ncommand = "x"\n\n[mcp_servers.lorepack]\ny = 1\n';
    const span = tableSpan(text, PATH);

    expect(span?.start).toBe(3);
  });

  it('finds nothing when the table is not there', () => {
    expect(tableSpan('[other]\na = 1\n', PATH)).toBeUndefined();
  });
});

describe('splicing', () => {
  it('appends to a file that has no such table, keeping every existing line', () => {
    const before = '# mine\nmodel = "x"\n\n[other]\na = 1\n';
    const after = withTomlTable(config(before), PATH, block());

    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain('[mcp_servers.lorepack]');
    expect(() => parse(after)).not.toThrow();
  });

  it('writes into an empty file without a leading blank line', () => {
    expect(withTomlTable(config(''), PATH, block()).startsWith('# Managed by Lorepack.')).toBe(
      true,
    );
  });

  it('replaces in place, leaving what comes after exactly where it was', () => {
    const before = `# mine\n\n${block('/old')}\n\n[other]\na = 1\n`;
    const after = withTomlTable(config(before), PATH, block('/new'));

    expect(after).toContain('/new');
    expect(after).not.toContain('/old');
    expect(after.endsWith('[other]\na = 1\n')).toBe(true);
    expect(after.split('[mcp_servers.lorepack]')).toHaveLength(2);
  });

  it('is byte-identical when applied twice', () => {
    const before = '# mine\nmodel = "x"\n\n[other]\na = 1\n';
    const once = withTomlTable(config(before), PATH, block());
    const twice = withTomlTable(config(once), PATH, block());

    expect(twice).toBe(once);
  });

  it('keeps CRLF endings rather than rewriting the whole file', () => {
    const before = 'model = "x"\r\n\r\n[other]\r\na = 1\r\n';
    const after = withTomlTable(config(before), PATH, block());

    // A connector that silently converts a Windows user's line endings shows up as an
    // entire-file diff in their next commit.
    expect(after).not.toMatch(/[^\r]\n/);
    expect(() => parse(after)).not.toThrow();
  });
});

describe('removing', () => {
  it('takes back only our lines', () => {
    const before = `# mine\nmodel = "x"\n\n${block()}\n\n[other]\na = 1\n`;
    const { text, removed } = withoutTomlTable(config(before), PATH);

    expect(removed).toBe(true);
    expect(text).toBe('# mine\nmodel = "x"\n\n[other]\na = 1\n');
  });

  it('refuses a table Lorepack did not write', () => {
    const before = '[mcp_servers.lorepack]\ncommand = "theirs"\n';
    const { text, removed } = withoutTomlTable(config(before), PATH);

    // No ownership comment, so it is not ours. Removing it because the name matched is the
    // corruption the marker exists to prevent.
    expect(removed).toBe(false);
    expect(text).toBe(before);
  });

  it('refuses a table another project\u2019s Lorepack wrote', () => {
    const before = block('/somewhere/else');
    const { removed } = withoutTomlTable(config(before), PATH, '/here');

    expect(removed).toBe(false);
  });

  it('leaves an empty file empty rather than leaving stray blank lines', () => {
    const { text } = withoutTomlTable(config(`${block()}\n`), PATH);
    expect(text).toBe('');
  });
});

describe('ownership, which is a comment on purpose', () => {
  it('round-trips the project it was written for', () => {
    expect(ownerOfTable(block('/a/project'), PATH)).toEqual({
      projectRoot: '/a/project',
      createdAt: '2026-08-05T00:00:00.000Z',
    });
  });

  it('is invisible to the client, because a comment always is', () => {
    const parsed = parse(block()) as Record<string, never>;
    // The reason it is not a key: a marker Codex one day refuses is a configuration that no
    // longer loads, with our name on the change.
    expect(Object.keys(parsed.mcp_servers.lorepack)).toEqual(['command', 'args', 'cwd']);
  });

  it('claims nothing when the marker is damaged', () => {
    expect(ownerOfTable('# x-lorepack not-json\n[mcp_servers.lorepack]\n', PATH)).toBeUndefined();
  });
});

describe('escaping, and the file on disk', () => {
  it('escapes what would otherwise break out of a string', () => {
    expect(tomlString('C:\\Users\\me')).toBe('"C:\\\\Users\\\\me"');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString('a\u0007b')).toBe('"a\\u0007b"');
    expect(parse(`a = ${tomlString('C:\\Users\\me\\a "project"')}`)).toEqual({
      a: 'C:\\Users\\me\\a "project"',
    });
  });

  it('refuses a file that does not parse, rather than replacing it', () => {
    const path = join(directory, 'config.toml');
    writeFileSync(path, '[unclosed\n', 'utf8');

    expect(() => readTomlConfig(path)).toThrow(/not valid TOML/);
    expect(readFileSync(path, 'utf8')).toBe('[unclosed\n');
  });

  /**
   * Found by measurement, not by reading: `smol-toml` rejects a leading byte order mark, and
   * Windows editors write them. Reporting that as a broken configuration would be wrong, and
   * dropping it on write would be a diff the user did not ask for.
   */
  it('reads a file with a byte order mark, and writes it back', () => {
    const path = join(directory, 'config.toml');
    writeFileSync(path, '\ufeffmodel = "x"\n', 'utf8');

    const read = readTomlConfig(path);
    expect(read.bom).toBe(true);
    expect(read.document.model).toBe('x');

    writeTextAtomically(path, withTomlTable(read, PATH, block()), read.bom);
    expect(readFileSync(path, 'utf8').startsWith('\ufeff')).toBe(true);
  });

  it('treats a missing or blank file as an empty configuration', () => {
    expect(readTomlConfig(join(directory, 'nope.toml')).document).toEqual({});
    const blank = join(directory, 'blank.toml');
    writeFileSync(blank, '\n\n', 'utf8');
    expect(readTomlConfig(blank).document).toEqual({});
  });
});
