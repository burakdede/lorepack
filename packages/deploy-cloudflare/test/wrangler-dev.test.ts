import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildManifest, hashBytes, type SourceReadResult } from '@lorepack/core';
import { MCP_PROTOCOL_VERSION } from '@lorepack/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { r2ObjectKey } from '../src/r2-keys.js';

const BUILD = `lore_${'a'.repeat(64)}`;
const CANDIDATE_BUILD = `lore_${'b'.repeat(64)}`;
const PROJECT = 'demo';
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
  counts: { artifacts: 1, nodes: 2, chunks: 0, tables: 1, tableRows: 2 },
  warnings: [],
};

let persistTo = '';
let schemaFile = '';
let objectFile = '';
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

async function decodeMcp(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const payload = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice('data: '.length)
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

beforeAll(async () => {
  persistTo = mkdtempSync(join(tmpdir(), 'lore-wrangler-'));
  schemaFile = join(persistTo, 'seed.sql');
  objectFile = join(persistTo, 'rollback.md');

  writeFileSync(
    schemaFile,
    `CREATE TABLE active_build (
  id INTEGER PRIMARY KEY,
  build_id TEXT,
  generation INTEGER NOT NULL
);
CREATE TABLE build_manifests (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  PRIMARY KEY (project_id, build_id)
);
CREATE TABLE projected_builds (
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  build_schema_version INTEGER NOT NULL,
  compiler_version TEXT NOT NULL,
  projection_schema_version INTEGER NOT NULL,
  projected_at TEXT NOT NULL,
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
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  authority INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  object_hash TEXT NOT NULL
);
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
  line_end INTEGER
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
INSERT INTO active_build (id, build_id, generation)
VALUES (1, '${BUILD}', 7);
INSERT INTO build_manifests (project_id, build_id, manifest_json)
VALUES ('${PROJECT}', '${BUILD}', '${JSON.stringify(MANIFEST).replace(/'/g, "''")}');
INSERT INTO projected_builds (project_id, build_id, build_schema_version, compiler_version, projection_schema_version, projected_at)
VALUES ('${PROJECT}', '${BUILD}', 3, '0.1.0', 1, '2026-08-08T12:00:00.000Z');
INSERT INTO artifacts (id, project_id, build_id, relative_path, display_path, title, status, authority, media_type, object_hash)
VALUES ('${ARTIFACT_ID}', '${PROJECT}', '${BUILD}', '${ARTIFACT_PATH}', '${ARTIFACT_PATH}', 'Rollback', 'active', 50, 'text/markdown', '${OBJECT_HASH}');
INSERT INTO nodes (id, project_id, build_id, artifact_id, kind, ordinal, title, text, heading_path, line_start, line_end)
VALUES
  ('n0', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', 'paragraph', 0, NULL, 'To roll back a release, activate the previous build.', '["Rollback"]', 3, 3),
  ('n1', '${PROJECT}', '${BUILD}', '${ARTIFACT_ID}', 'paragraph', 1, NULL, 'Tell the team what changed after the rollback.', '["Rollback"]', 5, 5);
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

    const buildResponse = await worker.fetch('/v1/build');
    expect(buildResponse.status).toBe(200);
    expect(await buildResponse.json()).toMatchObject({
      buildId: BUILD,
      sourceState: 'unknown',
      projectName: PROJECT,
      capabilities: MANIFEST.capabilities,
      counts: MANIFEST.counts,
      warningCount: 0,
    });

    const sourceResponse = await worker.fetch(`/v1/sources/${encodeURIComponent(ARTIFACT_ID)}`);
    expect(sourceResponse.status).toBe(200);
    const source = (await sourceResponse.json()) as SourceReadResult;
    expect(source.buildId).toBe(BUILD);
    expect(source.text).toContain('activate the previous build');
    expect(source.locator.artifactId).toBe(ARTIFACT_ID);

    const listResponse = await worker.fetch('/v1/tables');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      tables: [{ tableId: TABLE_ID, name: 'Products' }],
    });

    const describeResponse = await worker.fetch(`/v1/tables/${encodeURIComponent(TABLE_ID)}`);
    expect(describeResponse.status).toBe(200);
    expect(await describeResponse.json()).toMatchObject({
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT c_0_sku, c_1_price FROM ${TABLE_SQL}` }),
    });
    expect(queryResponse.status).toBe(200);
    expect(await queryResponse.json()).toMatchObject({
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
    );
    expect(candidateResponse.status).toBe(404);

    const mcpResponse = await worker.fetch('/mcp', {
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
      await worker.fetch('/v1/builds'),
      await worker.fetch('/v1/builds/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ build: BUILD }),
      }),
    ];
    expect(writes.map((response) => response.status)).toEqual([404, 404]);
  }, 20_000);
});
