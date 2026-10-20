import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIdInputsSchema, tableDescriptionSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const storedTableDescriptionSchema = tableDescriptionSchema.omit({
  corpusId: true,
  namespaceId: true,
  buildId: true,
  sourceState: true,
});

const FIXTURES = join(import.meta.dirname, '../../../fixtures/builds');
const ARCHIVE = join(FIXTURES, 'csv_evidence_legacy.lorepack');
const PROVENANCE = join(FIXTURES, 'csv_evidence_legacy.provenance.json');
const INPUTS = join(FIXTURES, 'csv_evidence_legacy_inputs.json');
const BINARY = join(import.meta.dirname, '../dist/public-entry.js');
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

it('changes the CSV parser identity when sealed table evidence changes, issue430', async () => {
  if (!existsSync(ARCHIVE) || !existsSync(PROVENANCE)) {
    throw new Error(
      'The reviewed legacy CSV fixture is absent. Follow fixtures/builds/csv_evidence_legacy.md before running this regression.',
    );
  }
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const inputs = JSON.parse(readFileSync(INPUTS, 'utf8')) as Record<string, string>;
  expect(provenance.formatVersion).toBe(1);
  expect(provenance.producer).toEqual({
    head: '39f9cf3d544f919de3164b8c57a874942d03e8a0',
    tarballSha256: 'ee0a1c47b42c47e858a1aca1e83a0d2d02ff57b29e33ae4502ee0d51befbbdc2',
  });
  expect(sha256(readFileSync(ARCHIVE))).toBe(provenance.archive.sha256);
  expect(sha256(readFileSync(INPUTS))).toBe(provenance.inputsSha256);
  expect(sha256(provenance.recipeSource)).toBe(provenance.recipeSha256);
  expect(provenance.runtime).toMatchObject({
    node: 'v24.21.0',
    sqlite: '3.53.4',
    npm: '11.19.0',
    pnpm: '11.18.0',
  });
  for (const [path, bytes] of Object.entries(inputs)) {
    expect(sha256(bytes)).toBe(provenance.inputs[path]);
  }

  await withTempProject({ files: inputs }, async (project) => {
    const run = (...args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [BINARY, '--cwd', project.root, '--json', ...args], {
          encoding: 'utf8',
          env: {
            ...process.env,
            ...(process.platform === 'win32' ? { LOREPACK_OBSERVER_DIAGNOSTIC: '1' } : {}),
          },
        }),
      );
    const imported = run('import', ARCHIVE);
    expect(imported.buildId).toBe(provenance.archive.buildId);
    run('activate', imported.buildId);
    const directory = (buildId: string) => join(project.root, '.lore', 'builds', buildId);
    const identity = (buildId: string) =>
      buildIdInputsSchema.parse(
        JSON.parse(readFileSync(join(directory(buildId), 'reports/build-id-inputs.json'), 'utf8')),
      );
    const oldManifest = readFileSync(join(directory(imported.buildId), 'manifest.json'));
    const oldCatalog = sha256(readFileSync(join(directory(imported.buildId), 'context.sqlite')));
    const oldIdentity = identity(imported.buildId);
    expect(oldIdentity).toEqual(provenance.identity);
    expect(oldIdentity.parserVersions.csv).toBe('0.1.1');
    expect(oldIdentity.normalizationVersion).toBe(2);
    const legacyResult = run('inspect', 'tables', 'orders');
    expect(legacyResult.buildId).toBe(imported.buildId);
    const legacy = storedTableDescriptionSchema.parse(legacyResult.table);
    expect(legacy.columns.map(({ formula }) => formula)).toEqual(['unknown', 'unknown']);
    expect(legacy.conversionWarnings).toBeNull();
    expect(legacyResult.metadata.tableEvidence).toBeUndefined();
    expect(legacyResult.metadata.normalizationVersion).toBe(1);
    expect(legacy.sample).toHaveLength(2);
    const legacyArtifact = run('inspect', 'docs/orders.csv');
    expect(legacyArtifact.artifact.parser_version).toBe(oldIdentity.parserVersions.csv);

    const built = run('build');
    expect(built.counts).toMatchObject({ artifacts: 1, tables: 1, tableRows: 2 });
    const currentResult = run('inspect', 'tables', 'orders');
    expect(currentResult.buildId).toBe(built.buildId);
    const current = storedTableDescriptionSchema.parse(currentResult.table);
    expect(current.columns.map(({ formula }) => formula)).toEqual(['absent', 'absent']);
    expect(current.conversionWarnings).toEqual([]);
    expect(currentResult.metadata.normalizationVersion).toBe(1);
    expect(currentResult.metadata.tableEvidence).toEqual({
      version: 1,
      formulaColumns: [],
      conversionWarnings: [],
    });
    expect(current.sample).toEqual(legacy.sample);
    expect(current.locator).toEqual(legacy.locator);
    const currentIdentity = identity(built.buildId);
    const currentArtifact = run('inspect', 'docs/orders.csv');
    expect(currentArtifact.artifact.parser_version).toBe(currentIdentity.parserVersions.csv);
    expect(currentIdentity.normalizationVersion).toBe(oldIdentity.normalizationVersion);
    expect(run('inspect', 'tables', 'orders', '--build', imported.buildId)).toEqual(legacyResult);
    expect(readFileSync(join(directory(imported.buildId), 'manifest.json'))).toEqual(oldManifest);
    expect(sha256(readFileSync(join(directory(imported.buildId), 'context.sqlite')))).toBe(
      oldCatalog,
    );

    // Every registered parser affects the build ID; an unrelated XLSX bump is not CSV identity.
    expect(currentIdentity.parserVersions.csv).not.toBe(oldIdentity.parserVersions.csv);
  });
});
