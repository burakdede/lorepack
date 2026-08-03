import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildHandle, BuildId, BuildScope } from '@lorepack/core';
import {
  createMcpHttpHandler,
  LEGACY_HANDSHAKE_VERSIONS,
  MCP_PROTOCOL_VERSION,
} from '@lorepack/mcp';
import { createRuntime } from '@lorepack/runtime';
import { describe, expect, it } from 'vitest';

/**
 * The protocol revision this server speaks, asserted against the server rather than against
 * a literal, and against the repository's prose rather than against nothing (#188, #189).
 *
 * #188 was filed because `initialize` answers a superseded revision while fifteen files say
 * the server implements the current one. Both are true, and neither is the whole truth: the
 * handshake is the backward-compatibility path 2026-07-28 requires a server to keep, and
 * the revision it actually negotiates is the one `server/discover` reports.
 *
 * Establishing that turned up #189, which was a real defect rather than a wording problem,
 * and it is worth writing down **where era negotiation lives** so the next reader does not
 * repeat the search. It is in the transport *entry*, not in `Protocol.connect`:
 *
 * - `createMcpHandler` (HTTP) and `serveStdio` (stdio) classify the opening message, pick
 *   an era, and pin one instance from a factory. Both reach the modern era.
 * - `server.connect(transport)`, the hand-wired shape every SDK example shows, does none of
 *   that. The connection stays 2025-era and `server/discover` is answered with
 *   `Method not found` **even though the handler is registered**.
 *
 * So a modern-era assertion has to go through an entry. This file uses the HTTP one because
 * it is in-process and fast; `mcp-stdio.test.ts` covers the stdio entry against the real
 * binary. Both compare against the same constant, which is what keeps the two transports
 * from drifting apart.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = `lore_${'a'.repeat(64)}` as BuildId;

/** Discovery reads no build, so the scope only has to exist, not to answer. */
const unusedScope = {
  buildId: BUILD,
  catalog: {},
  tables: {},
  objects: {},
} as unknown as BuildScope;

function handler(): ReturnType<typeof createMcpHttpHandler> {
  const runtime = createRuntime({
    provider: {
      async current() {
        return { buildId: BUILD, generation: 1 };
      },
      async acquire(): Promise<BuildHandle> {
        return { buildId: BUILD, generation: 1, release() {} };
      },
    },
    open: async () => unusedScope,
    freshness: async () => 'clean',
  });
  return createMcpHttpHandler(runtime);
}

/** The `_meta` envelope every modern request carries, since there is no session to hold it. */
const envelope = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'contract-tests', version: '0.0.0' },
};

async function call(method: string): Promise<Record<string, unknown>> {
  const response = await handler().fetch(
    new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // Required on a modern POST, and its absence is a -32020, not a 404.
        'Mcp-Method': method,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: envelope } }),
    }),
  );

  const text = await response.text();
  // The entry may answer as JSON or as a single SSE frame; both carry one JSON-RPC object.
  const payload = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice('data: '.length)
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('the revision the server negotiates', () => {
  it('reports exactly the documented revision on server/discover', async () => {
    const body = await call('server/discover');
    const result = body.result as { supportedVersions?: string[] } | undefined;

    // Not `toContain`: advertising a second revision would be a capability the
    // documentation does not describe and the connector pages could not record.
    expect(result?.supportedVersions).toEqual([MCP_PROTOCOL_VERSION]);
  });

  it('refuses a request that claims any other revision', async () => {
    const response = await handler().fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: { ...envelope, 'io.modelcontextprotocol/protocolVersion': '2020-01-01' },
          },
        }),
      }),
    );

    const body = (await response.json()) as {
      error?: { code: number; data?: { supported?: string[] } };
    };
    // -32022 is UnsupportedProtocolVersion, renumbered from -32004 by 2026-07-28.
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toEqual([MCP_PROTOCOL_VERSION]);
  });

  it('does not claim the SDK handshake constant as its own revision', () => {
    // The trap #188 fell into. If a future SDK bump makes these equal, this test is the
    // place that says so out loud rather than leaving the distinction to a comment.
    expect(LEGACY_HANDSHAKE_VERSIONS).not.toContain(MCP_PROTOCOL_VERSION);
  });
});

/** Source and prose, but not the vendored world or build output. */
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.mjs', '.md'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

/**
 * The two files allowed to name a superseded revision, because explaining the distinction
 * is their job. Everywhere else, naming one is a claim about what the server speaks.
 */
const ALLOWED = new Set([
  ['packages', 'mcp', 'src', 'protocol.ts'].join('/'),
  ['docs', 'architecture', 'serving.md'].join('/'),
]);

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      yield full;
    }
  }
}

describe('what the repository says about the revision', () => {
  it('names no MCP revision other than the one the server negotiates', () => {
    // Every revision the SDK knows about, so the list cannot go stale independently.
    const superseded = LEGACY_HANDSHAKE_VERSIONS.filter(
      (version) => version !== MCP_PROTOCOL_VERSION,
    );
    const stale: string[] = [];

    for (const file of walk(REPO_ROOT)) {
      const relativePath = relative(REPO_ROOT, file).split(sep).join('/');
      if (ALLOWED.has(relativePath)) continue;

      const text = readFileSync(file, 'utf8');
      for (const version of superseded) {
        if (text.includes(version)) stale.push(`${relativePath} names ${version}`);
      }
    }

    expect(stale, 'these files name a revision the server does not negotiate').toEqual([]);
  });
});
