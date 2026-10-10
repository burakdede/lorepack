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
    name: 'a source root linked outside the project is refused, issue 583',
    path: 'packages/core/test/config.test.ts',
    patterns: [
      /refuses a directory root that links outside the project/,
      /refuses a file root that links outside the project/,
      /refuses a root reached through a linked intermediate directory/,
      /LORE_E_PATH_ESCAPE/,
    ],
  },
  {
    name: 'an escaping source root fails the real build command',
    path: 'packages/cli/test/security.e2e.test.ts',
    patterns: [/refuses a symlinked source root that escapes, and builds nothing/, /zebrafish/],
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
    name: 'repeated query terms cannot multiply FTS5 work',
    path: 'packages/cli/test/security.e2e.test.ts',
    patterns: [
      /a query cannot be made expensive by repeating it/,
      /past the distinct-term cap with a typed 400/,
      /\/v1\/context/,
    ],
  },
  {
    name: 'repeated query terms cost what one term costs on both adapters',
    path: 'packages/deploy-cloudflare/test/ranking-parity.test.ts',
    patterns: [
      /repeated query terms cost what one term costs/,
      /runtimes\.local, runtimes\.remote/,
      /toBeLessThan\(single/,
    ],
  },
  {
    name: 'localhost Origin validation protects the local write surface',
    path: 'packages/runtime/test/http.test.ts',
    patterns: [/refuses a non-loopback browser origin/, /allowSameOrigin/, /127\.0\.0\.1/],
  },
  {
    name: 'local write routes refuse other localhost ports, simple requests and an output path',
    path: 'packages/runtime/test/http.test.ts',
    patterns: [
      /refuses a loopback page on another port/,
      /refuses a simple-request body with 415/,
      /will not let an HTTP caller choose where an archive is written/,
    ],
  },
  {
    name: 'a Host allowlist stops DNS rebinding on REST and MCP',
    path: 'tools/security/test/local-server.test.ts',
    patterns: [/DNS rebinding/, /attacker\.example/, /\/v1\/sources/, /\/mcp/, /toBe\(403\)/],
  },
  {
    name: 'the runtime refuses a foreign Host before any handler runs',
    path: 'packages/runtime/test/http.test.ts',
    patterns: [/refuses a foreign Host before any handler runs/, /allowedHosts/],
  },
  {
    name: 'a non-loopback dev bind serves no write route',
    path: 'packages/cli/test/dev.e2e.test.ts',
    patterns: [
      /--host', '0\.0\.0\.0'/,
      /serves no write route, plan or diagnostics/,
      /toBe\(404\)/,
    ],
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
    name: 'connect refuses project config links and keeps client config modes',
    path: 'packages/connect-clients/test/contract.ts',
    patterns: [
      /refuses a project file that is a link, and reads, writes and backs up nothing/,
      /refuses a project file reached through a linked directory/,
      /keeps a private user file private through connect and disconnect/,
      /edits a linked user file at its target, and keeps the link/,
    ],
  },
  {
    name: 'connect refuses a linked project config end to end',
    path: 'packages/cli/test/connect.test.ts',
    patterns: [/LORE_E_PATH_ESCAPE/, /sk-ant-SECRET/, /isSymbolicLink\(\)\)\.toBe\(true\)/],
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
