import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuildDescription,
  type BuildManifest,
  hashBytes,
  type SourceListResult,
  type SourceReadResult,
  verifyContextReceipt,
} from '@lorepack/core';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { PROJECTION_MIGRATIONS } from '../src/projection-migrations.js';
import { r2ObjectKey } from '../src/r2-keys.js';

const BUILD = `lore_${'a'.repeat(64)}`;
const CANDIDATE_BUILD = `lore_${'b'.repeat(64)}`;
const PROJECT = 'demo';
const CORPUS_ID = `corpus_${'c'.repeat(32)}`;
const ARTIFACT_ID = 'demo:guides/rollback.md';
const ARTIFACT_PATH = 'guides/rollback.md';
const TABLE_ID = 'demo:products';
const CANDIDATE_TABLE_ID = 'demo:products-candidate';
const TABLE_SQL = 't_products_active';
const CANDIDATE_TABLE_SQL = 't_products_candidate';
const WORKER_ROOT = join(import.meta.dirname, '..');
const WRANGLER_BIN = join(WORKER_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = join(WORKER_ROOT, 'wrangler.jsonc');
const OBJECT_BODY =
  '# Rollback\n\nTo roll back a release, activate the previous build.\n\nTell the team what changed after the rollback.\n';
const OBJECT_HASH = hashBytes(new TextEncoder().encode(OBJECT_BODY));
const ALIAS_ID = 'demo:alias.md';
const ALIAS_BODY = '# Namespace alias\n\nThe alias body belongs to another source.\n';
const ALIAS_HASH = hashBytes(new TextEncoder().encode(ALIAS_BODY));
const TOKEN = 'lore_rt_acceptance_worker_token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const DEPLOYMENT_CREDENTIAL = 'cf_api_token_for_deploy';
const DEPLOYMENT_CREDENTIAL_HASH = createHash('sha256').update(DEPLOYMENT_CREDENTIAL).digest('hex');

const MANIFEST: BuildManifest = {
  formatVersion: 1,
  buildId: BUILD,
  projectName: PROJECT,
  compilerVersion: '0.1.0',
  schemaVersion: 1,
  configurationHash: 'c'.repeat(64),
  sourceFingerprint: 'd'.repeat(64),
  canonicalRoots: {
    artifacts: 'e'.repeat(64),
    nodes: '1'.repeat(64),
    chunks: '2'.repeat(64),
    tables: '3'.repeat(64),
    objects: '4'.repeat(64),
  },
  capabilities: ['lexical-search', 'structured-context', 'table-query'],
  counts: { artifacts: 2, nodes: 3, chunks: 1, tables: 1, tableRows: 2 },
  warnings: [],
};

let persistTo = '';
let schemaFile = '';
let tableSchemaFile = '';
let objectFile = '';
let aliasFile = '';
let worker: Unstable_DevWorker | null = null;

const envelope = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'wrangler-dev-tests', version: '0.0.0' },
};

function runWrangler(args: readonly string[]): void {
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: WORKER_ROOT,
    env: { ...process.env, NO_D1_WARNING: 'true' },
    stdio: 'pipe',
  });
}

async function decodeMcp(response: Pick<Response, 'text'>): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice('data: '.length)
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

beforeAll(async () => {
  persistTo = mkdtempSync(join(tmpdir(), 'lore-wrangler-'));
  schemaFile = join(persistTo, 'seed.sql');
  tableSchemaFile = join(persistTo, 'table-seed.sql');
  objectFile = join(persistTo, 'rollback.md');
  aliasFile = join(persistTo, 'alias.md');

  writeFileSync(
    schemaFile,
    `CREATE TABLE active_build (
  id INTEGER PRIMARY KEY,
  build_id TEXT,
  generation INTEGER NOT NULL
);
CREATE TABLE runtime_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  project_id TEXT NOT NULL,
  corpus_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL
);
INSERT INTO runtime_identity (id, project_id, corpus_id, namespace_id)
VALUES (1, '${PROJECT}', '${CORPUS_ID}', 'namespace_' || lower(hex(randomblob(16))));
CREATE TABLE build_manifests (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id)
);
CREATE TABLE runtime_read_owners (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE TABLE retention_claims (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id)
);
CREATE TABLE projected_builds (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  build_schema_version INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  projection_schema_version INTEGER NOT NULL,
  projected_at TEXT NOT NULL,
  verified_at TEXT,
  activated_at TEXT,
  PRIMARY KEY (project_id, build_id)
);
CREATE TABLE build_warnings (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  code TEXT NOT NULL,
  class TEXT NOT NULL,
  path TEXT,
  message TEXT NOT NULL
);
${PROJECTION_MIGRATIONS[0]?.statements.find((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS artifacts ('))};
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  text TEXT,
  heading_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE tables (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sheet TEXT,
  sql_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  cell_range TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, build_id, id)
);
CREATE TABLE table_columns (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  sql_name TEXT NOT NULL,
  type TEXT NOT NULL,
  nullable INTEGER NOT NULL,
  null_count INTEGER NOT NULL,
  distinct_estimate INTEGER NOT NULL,
  distinct_is_exact INTEGER NOT NULL,
  min_value TEXT,
  max_value TEXT,
  PRIMARY KEY (project_id, build_id, table_id, ordinal)
);
${PROJECTION_MIGRATIONS[0]?.statements.filter((statement) => /^CREATE (?:TABLE IF NOT EXISTS (?:chunks|supersessions) \(|VIRTUAL TABLE IF NOT EXISTS chunks_fts )/.test(statement)).join(';\n')};
INSERT INTO active_build (id, build_id, generation)
VALUES (1, '${BUILD}', 7);
INSERT INTO build_manifests (project_id, build_id, manifest_json)
VALUES ('${PROJECT}', '${BUILD}', '${JSON.stringify(MANIFEST).replace(/'/g, "''")}');
INSERT INTO projected_builds (
  project_id,
  build_id,
  build_schema_version,
  compiler_version,
  projection_schema_version,
  projected_at,
  verified_at,
  activated_at
)
VALUES (
  '${PROJECT}',
  '${BUILD}',
  3,
  '0.1.0',
  4,
  '2026-08-08T12:00:00.000Z',
  '2026-08-08T12:00:30.000Z',
  '2026-08-08T12:00:45.000Z'
);
CREATE TABLE runtime_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
INSERT INTO runtime_tokens (token_hash, created_at, expires_at)
VALUES ('${TOKEN_HASH}', '2026-08-08T12:00:00.000Z', NULL);
INSERT INTO runtime_tokens (token_hash, created_at, expires_at)
VALUES ('${DEPLOYMENT_CREDENTIAL_HASH}', '2026-08-08T12:00:01.000Z', NULL);
INSERT INTO artifacts (id, project_id, build_id, relative_path, display_path, title, status, authority, media_type, object_hash)
VALUES
  ('${ALIAS_ID}', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', '${ARTIFACT_ID}', 'Alias', 'active', 50, 'text/markdown', '${ALIAS_HASH}'),
  ('${ARTIFACT_ID}', '${PROJECT}', '${BUILD}', '${ARTIFACT_PATH}', '${ARTIFACT_PATH}', 'Rollback', 'active', 50, 'text/markdown', '${OBJECT_HASH}');
INSERT INTO nodes (id, project_id, build_id, artifact_id, kind, ordinal, title, text, heading_path, line_start, line_end)
VALUES
  ('alias', '${PROJECT}', '${BUILD}', '${ALIAS_ID}', 'paragraph', 0, NULL, 'The alias body belongs to another source.', '[]', 3, 3),
  ('n0', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', 'paragraph', 0, NULL, 'To roll back a release, activate the previous build.', '["Rollback"]', 3, 3),
  ('n1', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', 'paragraph', 1, NULL, 'Tell the team what changed after the rollback.', '["Rollback"]', 5, 5);
INSERT INTO chunks (id, project_id, build_id, artifact_id, node_ids, heading_path, text, estimated_tokens, relative_path, line_start, line_end)
VALUES ('chunk-rollback', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', '["n0","n1"]', '["Rollback"]', 'To roll back a release, activate the previous build. Tell the team what changed after the rollback.', 25, '${ARTIFACT_PATH}', 3, 5);
INSERT INTO chunks_fts (project_id, build_id, chunk_id, artifact_id, status, authority, path, title, heading, body)
VALUES ('${PROJECT}', '${BUILD}', 'chunk-rollback', '${ARTIFACT_ID}', 'active', 50, '${ARTIFACT_PATH}', 'Rollback', 'Rollback', 'To roll back a release, activate the previous build. Tell the team what changed after the rollback.');
INSERT INTO tables (id, project_id, build_id, artifact_id, name, sheet, sql_name, row_count, relative_path, line_start, line_end, cell_range, metadata_json)
VALUES
  ('${TABLE_ID}', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', 'Products', 'Products', '${TABLE_SQL}', 2, '${ARTIFACT_PATH}', 1, 4, 'A1:B3', '{}'),
  ('${CANDIDATE_TABLE_ID}', '${PROJECT}', '${CANDIDATE_BUILD}', '${ARTIFACT_ID}', 'Products Candidate', 'Products', '${CANDIDATE_TABLE_SQL}', 1, '${ARTIFACT_PATH}', 1, 3, 'A1:B2', '{}');
INSERT INTO table_columns (project_id, build_id, table_id, ordinal, name, sql_name, type, nullable, null_count, distinct_estimate, distinct_is_exact, min_value, max_value)
VALUES
  ('${PROJECT}', '${BUILD}', '${TABLE_ID}', 0, 'SKU', 'c_0_sku', 'string', 0, 0, 2, 1, 'SKU-1', 'SKU-2'),
  ('${PROJECT}', '${BUILD}', '${TABLE_ID}', 1, 'Price', 'c_1_price', 'integer', 0, 0, 2, 1, '10', '20'),
  ('${PROJECT}', '${CANDIDATE_BUILD}', '${CANDIDATE_TABLE_ID}', 0, 'SKU', 'c_0_sku', 'string', 0, 0, 1, 1, 'SKU-C', 'SKU-C'),
  ('${PROJECT}', '${CANDIDATE_BUILD}', '${CANDIDATE_TABLE_ID}', 1, 'Price', 'c_1_price', 'integer', 0, 0, 1, 1, '99', '99');
CREATE TABLE ${TABLE_SQL} (
  c_0_sku TEXT NOT NULL,
  c_1_price INTEGER NOT NULL
);
INSERT INTO ${TABLE_SQL} (c_0_sku, c_1_price)
VALUES
  ('SKU-1', 10),
  ('SKU-2', 20);
CREATE TABLE ${CANDIDATE_TABLE_SQL} (
  c_0_sku TEXT NOT NULL,
  c_1_price INTEGER NOT NULL
);
INSERT INTO ${CANDIDATE_TABLE_SQL} (c_0_sku, c_1_price)
VALUES
  ('SKU-C', 99);
`,
  );
  writeFileSync(objectFile, OBJECT_BODY);
  writeFileSync(aliasFile, ALIAS_BODY);
  writeFileSync(
    tableSchemaFile,
    `CREATE TABLE ${TABLE_SQL} (c_0_sku TEXT NOT NULL, c_1_price INTEGER NOT NULL);
INSERT INTO ${TABLE_SQL} (c_0_sku, c_1_price) VALUES ('SKU-1', 10), ('SKU-2', 20);
CREATE TABLE ${CANDIDATE_TABLE_SQL} (c_0_sku TEXT NOT NULL, c_1_price INTEGER NOT NULL);
INSERT INTO ${CANDIDATE_TABLE_SQL} (c_0_sku, c_1_price) VALUES ('SKU-C', 99);
`,
  );

  runWrangler([
    'd1',
    'execute',
    'lorepack-catalog',
    '--local',
    '--config',
    CONFIG,
    '--persist-to',
    persistTo,
    '--file',
    schemaFile,
  ]);
  runWrangler([
    'd1',
    'execute',
    'lorepack-tables',
    '--local',
    '--config',
    CONFIG,
    '--persist-to',
    persistTo,
    '--file',
    tableSchemaFile,
  ]);
  runWrangler([
    'r2',
    'object',
    'put',
    `lorepack-build-objects-local/${r2ObjectKey(PROJECT, OBJECT_HASH)}`,
    '--local',
    '--config',
    CONFIG,
    '--persist-to',
    persistTo,
    '--file',
    objectFile,
  ]);
  runWrangler([
    'r2',
    'object',
    'put',
    `lorepack-build-objects-local/${r2ObjectKey(PROJECT, ALIAS_HASH)}`,
    '--local',
    '--config',
    CONFIG,
    '--persist-to',
    persistTo,
    '--file',
    aliasFile,
  ]);

  worker = await unstable_dev(join(WORKER_ROOT, 'src', 'worker.ts'), {
    config: CONFIG,
    local: true,
    persistTo,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, watch: false },
  });
}, 30_000);

afterAll(async () => {
  if (worker !== null) {
    await worker.stop();
  }
  rmSync(persistTo, { recursive: true, force: true });
}, 30_000);

describe('wrangler dev for the Worker runtime, issue 86', () => {
  it('serves the public read surface, including MCP, from local D1 and R2 emulation', async () => {
    if (worker === null) {
      throw new Error('wrangler dev did not start');
    }

    const health = await worker.fetch('/health');
    expect(health.status).toBe(200);

    const unauthorized = await worker.fetch('/v1/build');
    expect(unauthorized.status).toBe(401);
    const deploymentCredentialResponse = await worker.fetch('/v1/build', {
      headers: { Authorization: `Bearer ${DEPLOYMENT_CREDENTIAL}` },
    });
    expect(deploymentCredentialResponse.status).toBe(401);

    const auth = { Authorization: `Bearer ${TOKEN}` };

    const buildResponse = await worker.fetch('/v1/build', { headers: auth });
    expect(buildResponse.status).toBe(200);
    const build = (await buildResponse.json()) as BuildDescription;
    expect(build).toMatchObject({
      corpusId: CORPUS_ID,
      namespaceId: expect.stringMatching(/^namespace_[0-9a-f]{32}$/),
      buildId: BUILD,
      sourceState: 'unknown',
      projectName: PROJECT,
      capabilities: MANIFEST.capabilities,
      counts: MANIFEST.counts,
      warningCount: 0,
    });

    const inventoryResponse = await worker.fetch('/v1/sources?limit=1', { headers: auth });
    expect(inventoryResponse.status).toBe(200);
    const inventory = (await inventoryResponse.json()) as SourceListResult;
    expect(inventory).toMatchObject({
      corpusId: build.corpusId,
      namespaceId: build.namespaceId,
      buildId: BUILD,
      artifacts: [{ locator: { artifactId: ALIAS_ID, relativePath: ARTIFACT_ID } }],
      nextOffset: 1,
    });
    const continuation = await worker.fetch(
      `/v1/sources?buildId=${inventory.buildId}&offset=1&limit=1`,
      { headers: auth },
    );
    expect(continuation.status).toBe(200);
    const second = (await continuation.json()) as SourceListResult;
    expect(second).toMatchObject({
      corpusId: build.corpusId,
      namespaceId: build.namespaceId,
      buildId: BUILD,
      artifacts: [{ locator: { artifactId: ARTIFACT_ID, relativePath: ARTIFACT_PATH } }],
      nextOffset: null,
    });
    for (const [page, body] of [
      [inventory, ALIAS_BODY],
      [second, OBJECT_BODY],
    ] as const) {
      expect(page.artifacts).toHaveLength(1);
      const locator = page.artifacts[0]?.locator;
      if (locator?.artifactId === undefined)
        throw new Error('Inventory omitted its artifact locator');
      const response = await worker.fetch(
        `/v1/sources/${encodeURIComponent(locator.artifactId)}?buildId=${page.buildId}`,
        { headers: auth },
      );
      expect(response.status).toBe(200);
      const read = (await response.json()) as SourceReadResult;
      expect(read).toMatchObject({
        buildId: page.buildId,
        corpusId: page.corpusId,
        namespaceId: page.namespaceId,
        locator: { artifactId: locator.artifactId, relativePath: locator.relativePath },
      });
      expect(read.text).toBe(body);
    }
    const end = await worker.fetch(`/v1/sources?buildId=${BUILD}&offset=2`, { headers: auth });
    expect(await end.json()).toMatchObject({ buildId: BUILD, artifacts: [], nextOffset: null });
    const inventoryTool = await worker.fetch('/mcp', {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'lore_list_sources',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'lore_list_sources',
          arguments: { buildId: BUILD, limit: 1 },
          _meta: envelope,
        },
      }),
    });
    expect((await decodeMcp(inventoryTool)).result).toMatchObject({ structuredContent: inventory });

    const sourceResponse = await worker.fetch(`/v1/sources/${encodeURIComponent(ARTIFACT_ID)}`, {
      headers: auth,
    });
    expect(sourceResponse.status).toBe(200);
    const source = (await sourceResponse.json()) as SourceReadResult;
    expect(source).toMatchObject({ corpusId: build.corpusId, namespaceId: build.namespaceId });
    expect(source.buildId).toBe(BUILD);
    expect(source.text).toContain('activate the previous build');
    expect(source.locator.artifactId).toBe(ARTIFACT_ID);
    const aliasResponse = await worker.fetch('/mcp', {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'lore_read_source',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'lore_read_source',
          arguments: { path: ARTIFACT_ID, buildId: BUILD },
          _meta: envelope,
        },
      }),
    });
    expect(aliasResponse.status).toBe(200);
    const aliasFrame = await decodeMcp(aliasResponse);
    expect(
      (aliasFrame.result as { structuredContent: SourceReadResult }).structuredContent,
    ).toMatchObject({
      buildId: BUILD,
      text: ALIAS_BODY,
      locator: { artifactId: ALIAS_ID, relativePath: ARTIFACT_ID },
    });

    const listResponse = await worker.fetch('/v1/tables', { headers: auth });
    expect(listResponse.status).toBe(200);
    const tableList = {
      corpusId: CORPUS_ID,
      namespaceId: build.namespaceId,
      buildId: BUILD,
      sourceState: 'unknown',
      tables: [{ tableId: TABLE_ID, name: 'Products' }],
    };
    expect(await listResponse.json()).toEqual(tableList);
    const pinnedList = await worker.fetch(`/v1/tables?buildId=${BUILD}`, { headers: auth });
    expect(pinnedList.status).toBe(200);
    expect(await pinnedList.json()).toEqual(tableList);

    for (const selection of [{}, { buildId: BUILD }]) {
      const response = await worker.fetch('/mcp', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'lore_list_tables',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'lore_list_tables', arguments: selection, _meta: envelope },
        }),
      });
      expect(response.status).toBe(200);
      const frame = await decodeMcp(response);
      expect((frame.result as { structuredContent: unknown }).structuredContent).toEqual(tableList);
    }
    for (const uri of ['lore://project/tables', `lore://build/${BUILD}/tables`]) {
      const response = await worker.fetch('/mcp', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Method': 'resources/read',
          'Mcp-Name': uri,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/read',
          params: { uri, _meta: envelope },
        }),
      });
      expect(response.status).toBe(200);
      const frame = await decodeMcp(response);
      const contents = (frame.result as { contents: Array<{ text: string }> }).contents;
      expect(JSON.parse(contents[0]?.text ?? '{}')).toEqual(tableList);
    }

    const describeResponse = await worker.fetch(`/v1/tables/${encodeURIComponent(TABLE_ID)}`, {
      headers: auth,
    });
    expect(describeResponse.status).toBe(200);
    expect(await describeResponse.json()).toMatchObject({
      corpusId: build.corpusId,
      namespaceId: build.namespaceId,
      tableId: TABLE_ID,
      name: 'Products',
      sqlName: TABLE_SQL,
      sheet: 'Products',
      rowCount: 2,
      locator: {
        artifactId: ARTIFACT_ID,
        relativePath: ARTIFACT_PATH,
        sheet: 'Products',
        cellRange: 'A1:B3',
      },
      columns: [
        expect.objectContaining({ name: 'SKU', sqlName: 'c_0_sku', type: 'string' }),
        expect.objectContaining({ name: 'Price', sqlName: 'c_1_price', type: 'integer' }),
      ],
    });

    const queryResponse = await worker.fetch(`/v1/tables/${encodeURIComponent(TABLE_ID)}/query`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT c_0_sku, c_1_price FROM ${TABLE_SQL}` }),
    });
    expect(queryResponse.status).toBe(200);
    expect(await queryResponse.json()).toMatchObject({
      corpusId: build.corpusId,
      namespaceId: build.namespaceId,
      columns: ['SKU', 'Price'],
      rows: [
        { SKU: 'SKU-1', Price: 10 },
        { SKU: 'SKU-2', Price: 20 },
      ],
      rowCount: 2,
      truncated: false,
      locator: {
        artifactId: ARTIFACT_ID,
        relativePath: ARTIFACT_PATH,
        sheet: 'Products',
        cellRange: 'A1:B3',
      },
    });

    const candidateResponse = await worker.fetch(
      `/v1/tables/${encodeURIComponent(CANDIDATE_TABLE_ID)}`,
      { headers: auth },
    );
    expect(candidateResponse.status).toBe(404);

    const mcpResponse = await worker.fetch('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: envelope },
      }),
    });
    expect(mcpResponse.status).toBe(200);
    expect(await decodeMcp(mcpResponse)).toMatchObject({
      jsonrpc: '2.0',
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'lore_context_for_task' }),
          expect.objectContaining({ name: 'lore_search' }),
        ]),
      },
    });

    const writes = [
      await worker.fetch('/v1/builds', { headers: auth }),
      await worker.fetch('/v1/builds/activate', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ build: BUILD }),
      }),
    ];
    expect(writes.map((response) => response.status)).toEqual([404, 404]);
  }, 120_000);
});

it.each(['http', 'mcp'])(
  'verifies detached %s receipts in actual workerd, issue434',
  async (transport) => {
    if (worker === null) throw new Error('Worker setup did not run');
    const args = { task: 'rollback', buildId: BUILD, budget: 4000, receipt: true };
    const response = await worker.fetch(transport === 'http' ? '/v1/context' : '/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'lore_context_for_task',
      },
      body: JSON.stringify(
        transport === 'http'
          ? args
          : {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'lore_context_for_task', arguments: args, _meta: envelope },
            },
      ),
    });
    expect(response.status).toBe(200);
    let payload: string;
    let receipt: unknown;
    if (transport === 'http') {
      payload = await response.text();
      const header = response.headers.get('Lorepack-Context-Receipt');
      expect(header).not.toBeNull();
      receipt = JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'));
    } else {
      const frame = await decodeMcp(response);
      const result = frame.result as {
        content: unknown;
        structuredContent: unknown;
        _meta: Record<string, unknown>;
      };
      payload = JSON.stringify({
        content: result.content,
        structuredContent: result.structuredContent,
      });
      receipt = result._meta['lorepack.dev/context-receipt'];
    }
    const verified = await verifyContextReceipt(receipt, payload);
    expect(verified.buildId).toBe(BUILD);
    expect(verified.requestRetained).toBe(false);
  },
);
