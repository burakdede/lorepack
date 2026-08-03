import { describe, expect, it } from 'vitest';
import type { ConnectInput } from '../src/port.js';
import { renderSnippet, renderSnippetAdvice } from '../src/snippet.js';

/**
 * The honest answer for a client nobody has verified.
 *
 * Architecture 14.7 asks for a *verified snippet* rather than a speculative edit, and 14.7
 * also says the product must never claim every client can reach a localhost MCP server. Both
 * halves are assertable, and the second one is the kind of claim that creeps into copy.
 *
 * The quoting tests are the load-bearing ones. A project path with a space is ordinary; the
 * snippet is meant to be pasted into a shell; and getting Windows backslash rules wrong turns
 * `C:\\Users\\me\\docs` into an argument that ends in a quote character.
 */

function input(path: string): ConnectInput {
  return {
    projectRoot: path,
    serverName: 'lorepack',
    command: { executable: 'lore', args: ['mcp', '--project', path, '--ensure-current'] },
    scope: 'project',
  };
}

describe('the JSON form', () => {
  it('parses, and names the absolute path and --ensure-current', () => {
    const snippet = renderSnippet(input('/home/me/docs'));
    const parsed = JSON.parse(snippet.json) as Record<string, never>;

    expect(parsed.mcpServers.lorepack.command).toBe('lore');
    expect(parsed.mcpServers.lorepack.args).toEqual([
      'mcp',
      '--project',
      '/home/me/docs',
      '--ensure-current',
    ]);
  });

  it('carries no ownership marker, because nothing owns a snippet someone pasted', () => {
    const snippet = renderSnippet(input('/home/me/docs'));
    expect(snippet.json).not.toContain('x-lorepack');
  });
});

describe('the command form', () => {
  it('leaves an ordinary path unquoted, so it stays readable', () => {
    const snippet = renderSnippet(input('/home/me/docs'));
    expect(snippet.posixCommand).toBe('lore mcp --project /home/me/docs --ensure-current');
  });

  it('quotes a POSIX path with a space', () => {
    const snippet = renderSnippet(input('/home/me/my documents'));
    expect(snippet.posixCommand).toContain(`'/home/me/my documents'`);
  });

  it('survives an apostrophe, which single quotes cannot contain directly', () => {
    const snippet = renderSnippet(input("/home/me/paul's docs"));

    // The closing-reopening dance, spelled out rather than pattern-matched: close the
    // quote, emit an escaped apostrophe, reopen. A regex here is how a correct escaping
    // gets "corrected" by someone reading a failing test.
    expect(snippet.posixCommand).toBe(
      `lore mcp --project '/home/me/paul'\\''s docs' --ensure-current`,
    );
  });

  it('quotes a Windows path with a space without mangling its backslashes', () => {
    const snippet = renderSnippet(input('C:\\Users\\me\\my documents'));

    expect(snippet.windowsCommand).toContain('"C:\\Users\\me\\my documents"');
    // The failure this guards: a trailing backslash run before the closing quote has to be
    // doubled, or `CommandLineToArgvW` reads the quote as part of the argument.
    expect(snippet.windowsCommand.endsWith('--ensure-current')).toBe(true);
  });

  it('doubles a trailing backslash so the closing quote is not escaped', () => {
    const snippet = renderSnippet(input('C:\\Users\\me\\docs dir\\'));
    // Two backslashes before the closing quote means one literal backslash, and a quote that
    // still closes the argument.
    expect(snippet.windowsCommand).toContain('docs dir\\\\"');
  });
});

describe('what it claims', () => {
  it('names the verified clients and calls everything else unverified', () => {
    const advice = renderSnippetAdvice(['claude-code']).join('\n');

    expect(advice).toContain('claude-code');
    expect(advice).toContain('unverified');
  });

  it('does not imply that every client can reach a local server', () => {
    const advice = renderSnippetAdvice(['claude-code']).join('\n');

    // Architecture 14.7 is explicit about this, and it is exactly the sort of claim that
    // creeps into product copy because it sounds welcoming.
    expect(advice).toContain('cannot reach a local server');
    expect(advice).toContain('lore export');
  });
});
