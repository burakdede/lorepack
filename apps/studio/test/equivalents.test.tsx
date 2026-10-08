import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Equivalents } from '../src/components/Equivalents.js';
import {
  contextEquivalents,
  formatMcp,
  readSourceEquivalents,
  searchEquivalents,
  shellQuote,
  tableQueryEquivalents,
} from '../src/lib/equivalents.js';

/**
 * One request, three renderings. The promise is that a developer can paste any of them and
 * make the request Studio made, so these assert round trips, not substrings: the body a curl
 * line carries parses back to the request, and the MCP arguments are the request.
 *
 * The browser suite then runs the HTTP and MCP forms against a real server.
 */

const ORIGIN = 'http://127.0.0.1:43110';

/** Undoes `shellQuote`, the way a POSIX shell would. */
function unquote(word: string): string {
  if (!word.startsWith("'")) return word;
  return word.slice(1, -1).replaceAll("'\\''", "'");
}

/** The JSON a curl line posts. */
function curlBody(http: string): unknown {
  const match = /-d ('(?:[^']|'\\'')*'|\S+)$/.exec(http);
  expect(match, 'the curl line should carry a body').not.toBeNull();
  return JSON.parse(unquote(match?.[1] ?? ''));
}

describe('shell quoting', () => {
  it('leaves plain words alone and quotes everything else', () => {
    expect(shellQuote('agent')).toBe('agent');
    expect(shellQuote('how do I roll back')).toBe("'how do I roll back'");
  });

  it('survives a single quote and anything a shell would expand', () => {
    const awkward = 'it\'s $HOME `whoami` "quoted"';
    expect(unquote(shellQuote(awkward))).toBe(awkward);
    expect(shellQuote(awkward)).toBe("'it'\\''s $HOME `whoami` \"quoted\"'");
  });
});

describe('a context request', () => {
  it('is the same request in every form', () => {
    const request = { task: "what's our retention window", profile: 'agent', budget: 8000 };
    const forms = contextEquivalents(request, ORIGIN);

    expect(forms.cli).toBe(
      "lorepack export --task 'what'\\''s our retention window' --profile agent --budget 8000",
    );
    expect(forms.http).toContain(`${ORIGIN}/v1/context`);
    expect(curlBody(forms.http)).toEqual(request);
    expect(forms.mcp).toEqual({ name: 'lore_context_for_task', arguments: request });
  });

  it('passes no budget when the profile default was used', () => {
    const forms = contextEquivalents({ task: 'rollback', profile: 'chat' }, ORIGIN);
    expect(forms.cli).toBe('lorepack export --task rollback --profile chat');
    expect(curlBody(forms.http)).toEqual({ task: 'rollback', profile: 'chat' });
  });
});

describe('the other requests', () => {
  it('writes a search with its debug flag', () => {
    const forms = searchEquivalents({ query: 'roll back', debug: true }, ORIGIN);
    expect(forms.cli).toBe("lorepack search 'roll back' --debug");
    expect(curlBody(forms.http)).toEqual({ query: 'roll back', debug: true });
    expect(forms.mcp.name).toBe('lore_search');
  });

  it('offers no CLI line for a table query, because the CLI has no SQL command', () => {
    const forms = tableQueryEquivalents('t_orders', 'SELECT 1', ORIGIN);
    expect(forms.cli).toBeUndefined();
    expect(forms.http).toContain('/v1/tables/t_orders/query');
    expect(curlBody(forms.http)).toEqual({ sql: 'SELECT 1' });
    expect(forms.mcp).toEqual({
      name: 'lore_query_table',
      arguments: { tableId: 't_orders', sql: 'SELECT 1' },
    });
  });

  it('reads a source with or without its cited lines', () => {
    const whole = readSourceEquivalents('docs:runbook.md', null, ORIGIN);
    expect(whole.cli).toBeUndefined();
    expect(whole.http).toBe(`curl -s ${ORIGIN}/v1/sources/docs%3Arunbook.md`);
    expect(whole.mcp.arguments).toEqual({ artifactId: 'docs:runbook.md' });

    const cited = readSourceEquivalents('docs:runbook.md', { start: 9, end: 11 }, ORIGIN);
    expect(cited.http).toBe(
      `curl -s '${ORIGIN}/v1/sources/docs%3Arunbook.md?lineStart=9&lineEnd=11'`,
    );
    expect(cited.mcp.arguments).toEqual({
      artifactId: 'docs:runbook.md',
      lineStart: 9,
      lineEnd: 11,
    });
  });

  it('writes MCP as the tools/call params a client sends', () => {
    expect(JSON.parse(formatMcp({ name: 'lore_search', arguments: { query: 'x' } }))).toEqual({
      name: 'lore_search',
      arguments: { query: 'x' },
    });
  });
});

describe('the panel', () => {
  it('shows one form at a time and copies the one on screen', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const forms = contextEquivalents({ task: 'rollback', profile: 'agent' }, ORIGIN);
    render(<Equivalents forms={forms} />);

    const panel = screen.getByRole('region', { name: 'Use it anywhere' });
    expect(within(panel).getByRole('tab', { name: 'CLI' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByRole('tabpanel')).toHaveTextContent(forms.cli ?? '');

    await userEvent.click(within(panel).getByRole('tab', { name: 'MCP' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Copy the MCP form' }));
    expect(writeText).toHaveBeenCalledWith(formatMcp(forms.mcp));
    expect(await within(panel).findByText('Copied')).toBeInTheDocument();
  });

  it('starts on HTTP when there is no CLI form', () => {
    render(<Equivalents forms={tableQueryEquivalents('t', 'SELECT 1', ORIGIN)} />);
    expect(screen.queryByRole('tab', { name: 'CLI' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'HTTP' })).toHaveAttribute('aria-selected', 'true');
  });
});
