import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildManifest, hashBytes, objectKey, type SourceReadResult } from '@lorepack/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';

const BUILD = `lore_${'a'.repeat(64)}`;
const PROJECT = 'demo';
const ARTIFACT_ID = 'demo:guides/rollback.md';
const ARTIFACT_PATH = 'guides/rollback.md';
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
  counts: { artifacts: 1, nodes: 2, chunks: 0, tables: 0, tableRows: 0 },
  warnings: [],
};

let persistTo = '';
let schemaFile = '';
let objectFile = '';
let worker: Unstable_DevWorker | null = null;

function runWrangler(args: readonly string[]): void {
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: WORKER_ROOT,
    env: { ...process.env, NO_D1_WARNING: 'true' },
    stdio: 'pipe',
  });
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
    `lorepack-build-objects-local/${objectKey(OBJECT_HASH)}`,
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
  it('serves build metadata and source bodies from local D1 and R2 emulation', async () => {
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
  }, 20_000);
});
