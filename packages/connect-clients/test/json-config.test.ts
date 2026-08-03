import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backup,
  isOwned,
  markOwned,
  readJsonConfig,
  withoutServerEntry,
  withServerEntry,
  writeJsonAtomically,
} from '../src/json-config.js';

/**
 * Editing a file that belongs to someone else.
 *
 * Architecture 24.8 names client-configuration corruption as a real risk, and it is the kind
 * that is discovered late: the file also holds servers a person configured by hand, and one
 * that quietly disappears gets blamed on the client, not on us.
 *
 * So every test here is a way of losing someone's configuration, and the assertion is that
 * it does not happen.
 */

let directory: string;
let path: string;

const THIRD_PARTY = {
  mcpServers: {
    'someone-elses-server': { command: 'their-binary', args: ['--serve'] },
  },
  unrelatedTopLevelSetting: { theme: 'dark' },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lore-connect-'));
  path = join(directory, 'client.json');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('reading a client configuration', () => {
  it('treats an absent file as empty rather than an error', () => {
    expect(readJsonConfig(join(directory, 'nothing-here.json'))).toEqual({});
  });

  it('treats an empty file as empty, because a client may have created it and stopped', () => {
    writeFileSync(path, '   \n', 'utf8');
    expect(readJsonConfig(path)).toEqual({});
  });

  it('refuses a file it cannot parse instead of overwriting it', () => {
    // The most destructive available behaviour would be to treat unparseable as empty and
    // write our own document over whatever the user actually has.
    writeFileSync(path, '{ "mcpServers": { unclosed', 'utf8');
    expect(() => readJsonConfig(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toContain('unclosed');
  });
});

describe('merging an entry', () => {
  it('leaves every unrelated entry and setting exactly where it was', () => {
    const merged = withServerEntry(THIRD_PARTY, 'mcpServers', 'lorepack', {
      command: 'lore',
      args: ['mcp'],
    });

    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers['someone-elses-server']).toEqual(THIRD_PARTY.mcpServers['someone-elses-server']);
    expect(merged.unrelatedTopLevelSetting).toEqual({ theme: 'dark' });
    expect(servers.lorepack).toEqual({ command: 'lore', args: ['mcp'] });
  });

  it('creates the container when the file has never held a server', () => {
    const merged = withServerEntry({ theme: 'dark' }, 'mcpServers', 'lorepack', {
      command: 'lore',
    });
    expect((merged.mcpServers as Record<string, unknown>).lorepack).toEqual({ command: 'lore' });
    expect(merged.theme).toBe('dark');
  });

  it('replaces a container that is the wrong shape rather than crashing on it', () => {
    // A client that wrote `"mcpServers": []` is not a reason to fail a connect, and the
    // array cannot hold a named entry in any case.
    const merged = withServerEntry({ mcpServers: [] }, 'mcpServers', 'lorepack', {
      command: 'lore',
    });
    expect((merged.mcpServers as Record<string, unknown>).lorepack).toBeDefined();
  });
});

describe('removing an entry', () => {
  it('removes only what Lorepack created', () => {
    const document = withServerEntry(
      THIRD_PARTY,
      'mcpServers',
      'lorepack',
      markOwned({ command: 'lore', args: ['mcp'] }, '/projects/mine'),
    );

    const { document: after, removed } = withoutServerEntry(document, 'mcpServers', 'lorepack');
    expect(removed).toBe(true);
    const servers = after.mcpServers as Record<string, unknown>;
    expect(servers.lorepack).toBeUndefined();
    // The whole point: the entry beside ours survives.
    expect(servers['someone-elses-server']).toBeDefined();
  });

  it('leaves an entry of the same name that we did not create', () => {
    // Someone configured a server called `lorepack` by hand. Deleting it because the name
    // matches would be exactly the corruption this port exists to prevent.
    const document = withServerEntry(THIRD_PARTY, 'mcpServers', 'lorepack', {
      command: 'their-own-lorepack',
    });

    const { document: after, removed } = withoutServerEntry(document, 'mcpServers', 'lorepack');
    expect(removed).toBe(false);
    expect((after.mcpServers as Record<string, unknown>).lorepack).toEqual({
      command: 'their-own-lorepack',
    });
  });

  it('leaves an entry another project created, when a project is named', () => {
    const document = withServerEntry(
      {},
      'mcpServers',
      'lorepack',
      markOwned({ command: 'lore' }, '/projects/theirs'),
    );

    const { removed } = withoutServerEntry(document, 'mcpServers', 'lorepack', '/projects/mine');
    expect(removed).toBe(false);
  });

  it('says nothing was removed when there was nothing to remove', () => {
    const { removed } = withoutServerEntry({}, 'mcpServers', 'lorepack');
    expect(removed).toBe(false);
  });
});

describe('ownership', () => {
  it('recognises what it marked, and nothing else', () => {
    expect(isOwned(markOwned({ command: 'lore' }, '/p'))).toBe(true);
    expect(isOwned({ command: 'lore' })).toBe(false);
    expect(isOwned(null)).toBe(false);
    expect(isOwned('a string')).toBe(false);
  });
});

describe('writing', () => {
  it('backs the file up with a timestamp before it is touched', () => {
    writeFileSync(path, JSON.stringify(THIRD_PARTY), 'utf8');
    const target = backup(path);

    expect(target).toBeDefined();
    expect(existsSync(target as string)).toBe(true);
    // The original, byte for byte, so an undo is possible without our help.
    expect(readFileSync(target as string, 'utf8')).toBe(JSON.stringify(THIRD_PARTY));
  });

  it('has nothing to back up when the file does not exist yet', () => {
    expect(backup(join(directory, 'absent.json'))).toBeUndefined();
  });

  it('writes atomically, leaving no partial file behind', () => {
    writeJsonAtomically(path, THIRD_PARTY);
    writeJsonAtomically(path, { mcpServers: { lorepack: { command: 'lore' } } });

    // A rename either happened or did not: the file parses, always.
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
    // And the temporary sibling is not left lying in the user's configuration directory.
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the directory a client has not made yet', () => {
    const nested = join(directory, 'deeply', 'nested', 'client.json');
    writeJsonAtomically(nested, { ok: true });
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ ok: true });
  });
});
