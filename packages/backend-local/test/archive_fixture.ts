import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BuildIdInputs,
  deriveBuildId,
  hashCanonical,
  hashRoot,
  SCHEMA_VERSION,
  sha256Hex,
} from '@lorepack/core';
import { loadMigrations, runMigrations } from '../src/migrations.js';
import { buildMigrationsDirectory } from '../src/migrations-path.js';
import { openWritable } from '../src/sqlite.js';

export function validBuild(
  root: string,
  projectName = 'empty',
): ReadonlyArray<readonly [string, Uint8Array]> {
  const catalog = join(root, 'empty.sqlite');
  const db = openWritable(catalog);
  try {
    runMigrations(db, loadMigrations(buildMigrationsDirectory()));
  } finally {
    db.close();
  }
  const empty = hashRoot([]);
  const roots = { artifacts: empty, nodes: empty, chunks: empty, tables: empty, objects: empty };
  const inputs: BuildIdInputs = {
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    compilerVersion: '0.1.0',
    canonicalizationVersion: 1,
    normalizationVersion: 1,
    effectiveConfig: { name: projectName },
    parserVersions: {},
    ruleResolution: [],
    embeddingProfile: null,
    canonicalRoots: roots,
  };
  const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  return [
    [
      'manifest.json',
      encode({
        formatVersion: 1,
        schemaVersion: SCHEMA_VERSION,
        compilerVersion: '0.1.0',
        buildId: deriveBuildId(inputs),
        projectName,
        configurationHash: hashCanonical({ name: projectName }),
        sourceFingerprint: sha256Hex(new Uint8Array()),
        canonicalRoots: roots,
        capabilities: ['lexical-search'],
        counts: { artifacts: 0, nodes: 0, chunks: 0, tables: 0, tableRows: 0 },
        warnings: [],
      }),
    ],
    ['context.sqlite', new Uint8Array(readFileSync(catalog))],
    ['reports/build-id-inputs.json', encode(inputs)],
  ];
}
