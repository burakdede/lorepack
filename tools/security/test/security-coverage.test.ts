import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

interface Evidence {
  readonly name: string;
  readonly path: string;
  readonly patterns: readonly RegExp[];
}

const EVIDENCE: readonly Evidence[] = [
  {
    name: 'path traversal is refused at the served source boundary',
    path: 'packages/cli/test/security.e2e.test.ts',
    patterns: [
      /a source read cannot escape the build/,
      /a relative traversal/,
      /encoded traversal/,
    ],
  },
  {
    name: 'symlink escape is refused during discovery',
    path: 'packages/compiler/test/discover.test.ts',
    patterns: [/outside\/secret\.md/, /symlink/i, /outside/i],
  },
  {
    name: 'malformed PDFs are parser fixtures, not crashes',
    path: 'packages/parsers/test/pdf.test.ts',
    patterns: [/malformed input, per section 20\.9/, /encrypted/i, /deeply nested document/],
  },
  {
    name: 'malformed Office files are parser fixtures, not crashes',
    path: 'packages/parsers/test/xlsx.test.ts',
    patterns: [/fails a sheet whose xml is malformed/, /password\|corrupt/, /DOCTYPE/],
  },
  {
    name: 'SQL injection and multi-statement attempts are rejected',
    path: 'packages/cli/test/security.e2e.test.ts',
    patterns: [/Only SELECT is allowed/, /Only one statement/, /readfile/, /load_extension/],
  },
  {
    name: 'oversized requests and responses are bounded',
    path: 'packages/runtime/test/http.test.ts',
    patterns: [/refuses an oversized body/, /DEFAULT_MAX_REQUEST_BYTES/, /413/],
  },
  {
    name: 'localhost Origin validation protects the local write surface',
    path: 'packages/runtime/test/http.test.ts',
    patterns: [/refuses a non-loopback browser origin/, /allowLoopbackOrigin/, /127\.0\.0\.1/],
  },
  {
    name: 'remote runtime auth rejects bypass attempts',
    path: 'packages/deploy-cloudflare/test/runtime-auth.test.ts',
    patterns: [
      /rejects missing or invalid bearer tokens/,
      /deployment credential/,
      /not valid for this build/,
    ],
  },
  {
    name: 'secret values are excluded from manifests and logs',
    path: 'packages/compiler/test/validate.test.ts',
    patterns: [/no-secrets-in-manifest/, /without echoing the secret/, /not\.toContain/],
  },
  {
    name: 'malicious config values are rendered through redaction',
    path: 'packages/cli/test/config-resolve.test.ts',
    patterns: [/never prints a value whose name looks like a credential/, /\[redacted\]/],
  },
  {
    name: 'REST and Worker errors redact bearer material',
    path: 'packages/deploy-cloudflare/test/worker-app.test.ts',
    patterns: [/never echoes rejected bearer or Access tokens/, /not\.toContain\(badBearer\)/],
  },
  {
    name: 'MCP exposes only read-only model-facing tools',
    path: 'tools/contract/test/mcp.test.ts',
    patterns: [/declares every tool read-only/, /destructiveHint/, /TOOL_NAMES/],
  },
  {
    name: 'privacy defaults block network calls in the build path',
    path: 'tools/security/test/privacy-defaults.test.ts',
    patterns: [/fetch and sockets blocked/, /network\.calls/, /toEqual\(\[\]\)/],
  },
];

describe('consolidated security suite coverage, issue 98', () => {
  for (const item of EVIDENCE) {
    it(item.name, () => {
      const text = read(item.path);
      for (const pattern of item.patterns) {
        expect(text, `${item.path} must match ${pattern}`).toMatch(pattern);
      }
    });
  }
});
