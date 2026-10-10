import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Evidence,
  type Outcome,
  problems,
  ROOT,
  runFiles,
  runVitest,
} from './support/evidence.js';

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/**
 * The test files under this suite's own root, which the repository-wide Vitest projects do
 * not include, so they run under `--root tools/security`.
 */
const SECURITY_ROOT = 'tools/security/';

const EVIDENCE: readonly Evidence[] = [
  {
    name: 'path traversal is refused at the served source boundary',
    path: 'packages/cli/test/security.e2e.test.ts',
    tests: [
      'a source read cannot escape the build refuses a relative traversal',
      'a source read cannot escape the build refuses an encoded traversal',
      'a source read cannot escape the build refuses a POSIX absolute path',
      'a source read cannot escape the build refuses a Windows absolute path',
      'a source read cannot escape the build refuses a UNC path',
      'a source read cannot escape the build refuses a null byte suffix',
      'a source read cannot escape the build refuses a path inside the build itself',
    ],
    patterns: [
      /a source read cannot escape the build/,
      /a relative traversal/,
      /encoded traversal/,
    ],
  },
  {
    name: 'symlink escape is refused during discovery',
    path: 'packages/compiler/test/discover.test.ts',
    tests: [
      'symlinks skips them by default, with a warning',
      'symlinks refuses one that escapes the root, even when following is enabled',
    ],
    patterns: [/outside\/secret\.md/, /symlink/i, /outside/i],
  },
  {
    name: 'a source root linked outside the project is refused, issue 583',
    path: 'packages/core/test/config.test.ts',
    tests: [
      'a source root behind a symbolic link refuses a directory root that links outside the project',
      'a source root behind a symbolic link refuses a file root that links outside the project',
      'a source root behind a symbolic link refuses a root reached through a linked intermediate directory',
    ],
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
    tests: [
      'a source root cannot carry the build outside the project refuses a symlinked source root that escapes, and builds nothing',
    ],
    patterns: [/refuses a symlinked source root that escapes, and builds nothing/, /zebrafish/],
  },
  {
    name: 'malformed PDFs are parser fixtures, not crashes',
    path: 'packages/parsers/test/pdf.test.ts',
    tests: [
      'what is out of scope, and says so fails a password-protected document with an actionable message',
      'malformed input, per section 20.9 fails a truncated file with a typed error rather than crashing',
      'malformed input, per section 20.9 fails bytes that are not a PDF at all',
      'malformed input, per section 20.9 does not hang or exhaust memory on a deeply nested document',
    ],
    patterns: [/malformed input, per section 20\.9/, /encrypted/i, /deeply nested document/],
  },
  {
    name: 'malformed Office files are parser fixtures, not crashes',
    path: 'packages/parsers/test/xlsx.test.ts',
    tests: [
      'hardening refuses a part that declares a document type',
      'hardening fails a file that is not a zip with an actionable message',
      'hardening fails a sheet whose xml is malformed',
    ],
    patterns: [/fails a sheet whose xml is malformed/, /password\|corrupt/, /DOCTYPE/],
  },
  {
    name: 'SQL injection and multi-statement attempts are rejected',
    path: 'packages/cli/test/security.e2e.test.ts',
    tests: [
      'the SQL surface refuses everything but one read of one table refuses a write, by the rule that covers it',
      'the SQL surface refuses everything but one read of one table refuses a second statement, by the rule that covers it',
      'the SQL surface refuses everything but one read of one table refuses a second statement hidden by a comment, by the rule that covers it',
      'the SQL surface refuses everything but one read of one table refuses a file read, by the rule that covers it',
      'the SQL surface refuses everything but one read of one table refuses an attach, by the rule that covers it',
      'the SQL surface refuses everything but one read of one table refuses a load_extension, by the rule that covers it',
    ],
    patterns: [/Only SELECT is allowed/, /Only one statement/, /readfile/, /load_extension/],
  },
  {
    name: 'oversized requests and responses are bounded',
    path: 'packages/runtime/test/http.test.ts',
    tests: [
      'safety, architecture 19.4 and 20.9 refuses an oversized body by its declared length and by its real length',
    ],
    patterns: [/refuses an oversized body/, /DEFAULT_MAX_REQUEST_BYTES/, /413/],
  },
  {
    name: 'repeated query terms cannot multiply FTS5 work',
    path: 'packages/cli/test/security.e2e.test.ts',
    tests: [
      'a query cannot be made expensive by repeating it answers a repeated term at the length limit as it answers the term once',
      'a query cannot be made expensive by repeating it refuses /v1/search past the distinct-term cap with a typed 400',
      'a query cannot be made expensive by repeating it refuses /v1/context past the distinct-term cap with a typed 400',
    ],
    patterns: [
      /a query cannot be made expensive by repeating it/,
      /past the distinct-term cap with a typed 400/,
      /\/v1\/context/,
    ],
  },
  {
    name: 'repeated query terms cost what one term costs on both adapters',
    path: 'packages/deploy-cloudflare/test/ranking-parity.test.ts',
    tests: [
      'repeated query terms cost what one term costs, issue 625 answers a repeated term like the single term, in about the same time',
      'repeated query terms cost what one term costs, issue 625 refuses a query past the distinct-term cap on both adapters',
    ],
    patterns: [
      /repeated query terms cost what one term costs/,
      /runtimes\.local, runtimes\.remote/,
      /toBeLessThan\(single/,
    ],
  },
  {
    name: 'archive verification refuses a bomb before inflating it, issue 567',
    path: 'packages/backend-local/test/archive.test.ts',
    tests: [
      'archive verification refuses a bomb with a typed limit error before inflating it',
      'archive verification never inflates an unlisted member',
      'archive verification fails members named after Object.prototype keys as unlisted',
    ],
    patterns: [
      /refuses a bomb with a typed limit error before inflating it/,
      /never inflates an unlisted member/,
      /fails members named after Object\.prototype keys as unlisted/,
      /LORE_E_LIMIT_EXCEEDED/,
    ],
  },
  {
    name: 'pack --verify keeps memory flat on a hostile archive',
    path: 'packages/cli/test/pack-verify.e2e.test.ts',
    tests: [
      'lorepack pack --verify on a hostile archive refuses a decompression bomb with a typed limit error and flat memory',
      'lorepack pack --verify on a hostile archive hashes a large listed member as a stream rather than buffering it',
      'lorepack pack --verify on a hostile archive fails members named after Object.prototype keys as unlisted',
    ],
    patterns: [
      /refuses a decompression bomb with a typed limit error and flat memory/,
      /RSS_CEILING/,
    ],
  },
  {
    name: 'localhost Origin validation protects the local write surface',
    path: 'packages/runtime/test/http.test.ts',
    tests: [
      'safety, architecture 19.4 and 20.9 refuses a cross-origin browser request to everything except health',
      'the write surface, architecture 15.6 and 19.4 refuses a non-loopback browser origin: POST /v1/builds/activate',
      'the write surface, architecture 15.6 and 19.4 refuses a non-loopback browser origin: POST /v1/builds/rollback',
    ],
    patterns: [/refuses a non-loopback browser origin/, /allowSameOrigin/, /127\.0\.0\.1/],
  },
  {
    name: 'local write routes refuse other localhost ports, simple requests and an output path',
    path: 'packages/runtime/test/http.test.ts',
    tests: [
      'the write surface, architecture 15.6 and 19.4 refuses a loopback page on another port: POST /v1/builds/activate',
      'the write surface, architecture 15.6 and 19.4 refuses a loopback page on another port: POST /v1/builds/pack',
      'the request media type refuses a simple-request body with 415: /v1/builds/pack',
      'the write surface, architecture 15.6 and 19.4 will not let an HTTP caller choose where an archive is written',
    ],
    patterns: [
      /refuses a loopback page on another port/,
      /refuses a simple-request body with 415/,
      /will not let an HTTP caller choose where an archive is written/,
    ],
  },
  {
    name: 'a Host allowlist stops DNS rebinding on REST and MCP',
    path: 'tools/security/test/local-server.test.ts',
    tests: [
      'DNS rebinding: a foreign Host header reaches nothing (#547) refuses GET /v1/sources/docs%2Fsecret.md with Host: attacker.example',
      'DNS rebinding: a foreign Host header reaches nothing (#547) refuses POST /mcp with Host: attacker.example',
      'DNS rebinding: a foreign Host header reaches nothing (#547) still answers the same read on a loopback name, so the guard is not refusing everything',
      'another localhost page cannot write through the local server (#548) cannot pack over a file of its choosing, with or without a preflight-free body',
      'another localhost page cannot write through the local server (#548) refuses /v1/builds/activate from a localhost page on another port',
    ],
    patterns: [/DNS rebinding/, /attacker\.example/, /\/v1\/sources/, /\/mcp/, /toBe\(403\)/],
  },
  {
    name: 'the runtime refuses a foreign Host before any handler runs',
    path: 'packages/runtime/test/http.test.ts',
    tests: [
      'the Host header, which DNS rebinding cannot forge refuses a foreign Host before any handler runs: GET /v1/sources/p%3Aguides%2Fa.md',
      'the Host header, which DNS rebinding cannot forge refuses a foreign Host before any handler runs: POST /mcp',
      'the Host header, which DNS rebinding cannot forge refuses a request with no Host at all, which no real client sends',
    ],
    patterns: [/refuses a foreign Host before any handler runs/, /allowedHosts/],
  },
  {
    name: 'a non-loopback dev bind serves no write route',
    path: 'packages/cli/test/dev.e2e.test.ts',
    tests: [
      'binding beyond loopback with --host 0.0.0.0 serves no write route, plan or diagnostics, and says so',
    ],
    patterns: [
      /--host', '0\.0\.0\.0'/,
      /serves no write route, plan or diagnostics/,
      /toBe\(404\)/,
    ],
  },
  {
    name: 'remote runtime auth rejects bypass attempts',
    path: 'packages/deploy-cloudflare/test/runtime-auth.test.ts',
    tests: [
      'runtime token auth, issue 90 rejects missing or invalid bearer tokens with one non-enumerating message',
      'runtime token auth, issue 90 rejects a deployment credential even if its hash is stored remotely',
      'runtime token auth, issue 90 keeps the previous token valid through the overlap window, then expires it',
    ],
    patterns: [
      /rejects missing or invalid bearer tokens/,
      /deployment credential/,
      /not valid for this build/,
    ],
  },
  {
    name: 'secret values are excluded from manifests and logs',
    path: 'packages/compiler/test/validate.test.ts',
    tests: [
      'each check catches its own defect rejects a manifest containing a secret, without echoing the secret',
    ],
    patterns: [/no-secrets-in-manifest/, /without echoing the secret/, /not\.toContain/],
  },
  {
    name: 'malicious config values are rendered through redaction',
    path: 'packages/cli/test/config-resolve.test.ts',
    tests: ['secrets never prints a value whose name looks like a credential'],
    patterns: [/never prints a value whose name looks like a credential/, /\[redacted\]/],
  },
  {
    name: 'REST and Worker errors redact bearer material',
    path: 'packages/deploy-cloudflare/test/worker-app.test.ts',
    tests: [
      'the Worker-facing runtime assembly, issue 86 never echoes rejected bearer or Access tokens in the Worker 401 body',
    ],
    patterns: [/never echoes rejected bearer or Access tokens/, /not\.toContain\(badBearer\)/],
  },
  {
    name: 'MCP exposes only read-only model-facing tools',
    path: 'tools/contract/test/mcp.test.ts',
    tests: [
      'the tool surface, architecture 14.1 declares every tool read-only, and offers nothing that could change anything',
      'the stateless model never asks the client for input, because every tool is read-only',
    ],
    patterns: [/declares every tool read-only/, /destructiveHint/, /TOOL_NAMES/],
  },
  {
    name: 'connect refuses project config links and keeps client config modes',
    path: 'packages/connect-clients/test/contract.ts',
    tests: [
      "the file's permissions and links refuses a project file that is a link, and reads, writes and backs up nothing",
      "the file's permissions and links refuses a project file reached through a linked directory",
      "the file's permissions and links keeps a private user file private through connect and disconnect",
      "the file's permissions and links edits a linked user file at its target, and keeps the link",
    ],
    runFrom: [
      'packages/connect-clients/test/claude-code.test.ts',
      'packages/connect-clients/test/codex.test.ts',
      'packages/connect-clients/test/vscode.test.ts',
    ],
    skippedOn: {
      win32:
        'symbolic links need administrator rights or Developer Mode, and POSIX modes are not meaningful; macOS and Linux run the same code',
    },
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
    tests: [
      'a project configuration that is a link is refused, and the file it points at is neither read into the project nor changed',
    ],
    skippedOn: {
      win32:
        'symbolic links need administrator rights or Developer Mode; the adapter suites cover the refusal on macOS and Linux',
    },
    patterns: [/LORE_E_PATH_ESCAPE/, /sk-ant-SECRET/, /isSymbolicLink\(\)\)\.toBe\(true\)/],
  },
  {
    name: 'privacy defaults block network calls in the build path',
    path: 'tools/security/test/privacy-defaults.test.ts',
    tests: [
      'privacy defaults: no telemetry or source egress in the build path, issue 616 builds every parser format in a sandbox with no network, process or thread, and attempts nothing',
      'privacy defaults: no telemetry or source egress in the build path, issue 616 fails when the build path sends a DNS query',
      'privacy defaults: no telemetry or source egress in the build path, issue 616 fails when the build path sends a UDP datagram',
      'privacy defaults: no telemetry or source egress in the build path, issue 616 fails when the build path sends a child process that connects',
      'privacy defaults: no telemetry or source egress in the build path, issue 616 fails when the build path sends a fetch from a worker thread',
    ],
    patterns: [
      /builds every parser format in a sandbox/,
      /runSandboxedBuild/,
      /egressProblems\(run\)\)\.toEqual\(\[\]\)/,
    ],
  },
];

/**
 * Each class is held only if the tests that hold it ran and passed in this run.
 *
 * The first version matched regexes against the test source, so a `describe.skip`, a deleted
 * test or a test that never ran left this suite green (#615). The source patterns stay, as a
 * guard against a test emptied of its assertions, but the verdict comes from Vitest.
 */
describe('consolidated security suite coverage, issues 98 and 615', () => {
  let outcomes: readonly Outcome[] = [];

  beforeAll(() => {
    const files = [...new Set(EVIDENCE.flatMap(runFiles))].sort();
    const own = files.filter((file) => file.startsWith(SECURITY_ROOT));
    const rest = files.filter((file) => !file.startsWith(SECURITY_ROOT));
    outcomes = [
      ...runVitest(rest),
      ...runVitest(
        own.map((file) => file.slice(SECURITY_ROOT.length)),
        SECURITY_ROOT,
      ),
    ];
  }, 900_000);

  for (const item of EVIDENCE) {
    it(item.name, () => {
      expect(problems(item, outcomes)).toEqual([]);
      const text = read(item.path);
      for (const pattern of item.patterns) {
        expect(text, `${item.path} must match ${pattern}`).toMatch(pattern);
      }
    });
  }
});
