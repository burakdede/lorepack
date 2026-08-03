import type { ConnectInput, ConnectionCheck } from './port.js';
import { verifyStdioServer } from './verify.js';

/**
 * The honest answer for a client nobody has verified.
 *
 * Architecture 14.7 asks for a *verified snippet* rather than a speculative edit, and 6.6
 * makes this the documented degradation path. The distinction is the whole point: guessing
 * at a configuration shape nobody has tested turns a working setup into a broken one and
 * leaves the user with a file they did not write and cannot debug. A snippet costs them a
 * paste and cannot damage anything.
 *
 * **Verified means the server was actually started**, not that the JSON parses. A snippet
 * that names a command which does not run is exactly as useless as no snippet, and much more
 * confusing, because it looks like it should work.
 *
 * 14.7 also says the product must never claim every client can reach a localhost MCP server.
 * Plenty cannot, and for those the honest next step is `lore export`, not a snippet they will
 * paste somewhere that has nowhere to put it.
 */

export interface Snippet {
  /** The configuration most MCP clients accept, in the shape they document. */
  readonly json: string;
  /** The same server as a shell command, for a client that takes one. */
  readonly posixCommand: string;
  readonly windowsCommand: string;
  /** Absent until `renderVerifiedSnippet` has actually started the server. */
  readonly verification?: ConnectionCheck;
}

export function renderSnippet(input: ConnectInput): Snippet {
  const entry = {
    type: 'stdio',
    command: input.command.executable,
    args: [...input.command.args],
  };

  return {
    json: `${JSON.stringify({ mcpServers: { [input.serverName]: entry } }, null, 2)}\n`,
    posixCommand: `${input.command.executable} ${input.command.args.map(quotePosix).join(' ')}`,
    windowsCommand: `${input.command.executable} ${input.command.args.map(quoteWindows).join(' ')}`,
  };
}

/** Renders, then starts the server to find out whether the snippet is worth pasting. */
export async function renderVerifiedSnippet(input: ConnectInput): Promise<Snippet> {
  const snippet = renderSnippet(input);
  const verification = await verifyStdioServer({
    executable: input.command.executable,
    args: input.command.args,
  });
  return { ...snippet, verification };
}

/**
 * POSIX single quotes, which are literal for everything except a single quote.
 *
 * A project path with a space is ordinary, and one with an apostrophe is not rare. The
 * closing-reopening dance is the standard way to embed a quote inside single quotes.
 */
function quotePosix(argument: string): string {
  if (/^[\w./=-]+$/.test(argument)) return argument;
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * Windows double quotes, per the rules `CommandLineToArgvW` applies.
 *
 * Backslashes are literal except immediately before a quote, where they must be doubled, and
 * the trailing run before the closing quote must be doubled too. Getting this wrong turns
 * `C:\Users\me\docs` into an argument ending in a quote character.
 */
function quoteWindows(argument: string): string {
  if (/^[\w./=-]+$/.test(argument)) return argument;
  const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/** What to say about a client nobody has verified, without overclaiming. */
export function renderSnippetAdvice(supported: readonly string[]): readonly string[] {
  return [
    `Verified clients: ${supported.join(', ')}. Anything else is unverified, so this is a configuration to paste rather than an edit Lorepack will make.`,
    'If your client cannot speak MCP at all, it cannot reach a local server. Use `lore export --profile chat` for a bounded, cited file you can paste into it.',
  ];
}
