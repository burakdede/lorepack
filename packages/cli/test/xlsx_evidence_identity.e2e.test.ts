import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const WORKBOOK = join(FIXTURES, 'xlsx_evidence_legacy.xlsx');
const ARCHIVE = join(FIXTURES, 'xlsx_evidence_legacy.lorepack');
const PROVENANCE = join(FIXTURES, 'xlsx_evidence_legacy.provenance.json');
const BINARY = join(import.meta.dirname, '../dist/public-entry.js');
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

it('changes the XLSX parser identity when sealed formula evidence changes, issue430', async () => {
  if (![WORKBOOK, ARCHIVE, PROVENANCE].every(existsSync)) {
    throw new Error(
      'The reviewed legacy XLSX fixture is absent. Follow fixtures/builds/xlsx_evidence_legacy.md before running this regression.',
    );
  }
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  expect(provenance.formatVersion).toBe(1);
  expect(provenance.producer.head).toBe('c39e2b8ad38dd8181ca48ca6eadfd8a59e3fb0ed');
  expect(provenance.producer.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(sha256(readFileSync(ARCHIVE))).toBe(provenance.archive.sha256);
  expect(sha256(readFileSync(WORKBOOK))).toBe(provenance.workbookSha256);
  expect(sha256(provenance.recipeSource)).toBe(provenance.recipeSha256);
  expect(sha256(provenance.config)).toBe(provenance.configSha256);
  expect(provenance.tableId).toEqual(expect.any(String));
  expect(provenance.runtime).toMatchObject({
    node: 'v24.21.0',
    sqlite: '3.53.4',
    npm: '11.19.0',
    pnpm: '11.18.0',
  });

  const files = { 'lore.yaml': provenance.config as string };
  const placeWorkbook = (root: string): void => {
    const path = join(root, 'docs', 'rates.xlsx');
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(WORKBOOK, path);
  };
  const runAt = (root: string, ...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [BINARY, '--cwd', root, '--json', ...args], {
        encoding: 'utf8',
      }),
    );
  const directory = (root: string, buildId: string) => join(root, '.lore', 'builds', buildId);
  const identity = (root: string, buildId: string) =>
    buildIdInputsSchema.parse(
      JSON.parse(
        readFileSync(join(directory(root, buildId), 'reports/build-id-inputs.json'), 'utf8'),
      ),
    );

  const old = await withTempProject({ files }, async (project) => {
    placeWorkbook(project.root);
    const imported = runAt(project.root, 'import', ARCHIVE);
    expect(imported.buildId).toBe(provenance.archive.buildId);
    runAt(project.root, 'activate', imported.buildId);
    const listed = runAt(project.root, 'inspect', 'tables');
    expect(listed.tables).toHaveLength(1);
    expect(listed.tables[0]).toMatchObject({
      id: provenance.tableId,
      name: 'Rates',
      relativePath: 'rates.xlsx',
    });
    const tableId = provenance.tableId as string;
    const oldIdentity = identity(project.root, imported.buildId);
    expect(oldIdentity).toEqual(provenance.identity);
    expect(oldIdentity.parserVersions.xlsx).toBe('0.1.3');
    expect(oldIdentity.normalizationVersion).toBe(2);
    const original = runAt(project.root, 'inspect', 'tables', tableId);
    expect(original.buildId).toBe(imported.buildId);
    const description = storedTableDescriptionSchema.parse(original.table);
    expect(description.columns.map(({ formula }) => formula)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(description.conversionWarnings).toBeNull();
    expect(original.metadata.tableEvidence).toBeUndefined();
    expect(description.sample[0]?.computed).toBe(999);
    expect(description.sample[1]?.computed).toBe(3);
    const artifact = runAt(project.root, 'inspect', 'docs/rates.xlsx');
    expect(artifact.artifact.parser_version).toBe('0.1.3');
    const oldManifest = readFileSync(
      join(directory(project.root, imported.buildId), 'manifest.json'),
    );
    const oldCatalog = sha256(
      readFileSync(join(directory(project.root, imported.buildId), 'context.sqlite')),
    );

    const rebuilt = runAt(project.root, 'build');
    const afterRebuild = runAt(project.root, 'inspect', 'tables', tableId);
    console.info(
      JSON.stringify({
        xlsxEvidenceIdentityDiagnostic: {
          importedBuildId: imported.buildId,
          sameProjectRebuildId: rebuilt.buildId,
          sameProjectRebuildReturnedImportedId: rebuilt.buildId === imported.buildId,
          sameProjectTableEvidencePresent: afterRebuild.metadata.tableEvidence !== undefined,
        },
      }),
    );
    expect(readFileSync(join(directory(project.root, imported.buildId), 'manifest.json'))).toEqual(
      oldManifest,
    );
    expect(
      sha256(readFileSync(join(directory(project.root, imported.buildId), 'context.sqlite'))),
    ).toBe(oldCatalog);
    expect(runAt(project.root, 'inspect', 'tables', tableId, '--build', imported.buildId)).toEqual(
      original,
    );
    return { buildId: imported.buildId as string, identity: oldIdentity, description, tableId };
  });

  await withTempProject({ files }, async (project) => {
    placeWorkbook(project.root);
    const built = runAt(project.root, 'build');
    expect(built.counts).toMatchObject({ artifacts: 1, tables: 1, tableRows: 2 });
    const listed = runAt(project.root, 'inspect', 'tables');
    expect(listed.tables).toHaveLength(1);
    expect(listed.tables[0]).toMatchObject({
      id: old.tableId,
      name: 'Rates',
      relativePath: 'rates.xlsx',
    });
    const result = runAt(project.root, 'inspect', 'tables', old.tableId);
    expect(result.buildId).toBe(built.buildId);
    const current = storedTableDescriptionSchema.parse(result.table);
    expect(current.columns.map(({ formula }) => formula)).toEqual(['absent', 'present', 'absent']);
    expect(current.conversionWarnings).toEqual([]);
    expect(result.metadata.normalizationVersion).toBe(1);
    expect(result.metadata.tableEvidence).toEqual({
      version: 1,
      formulaColumns: [1],
      conversionWarnings: [],
    });
    expect(current.sample).toEqual(old.description.sample);
    expect(current.locator).toEqual(old.description.locator);
    const currentIdentity = identity(project.root, built.buildId);
    const artifact = runAt(project.root, 'inspect', 'docs/rates.xlsx');
    expect(artifact.artifact.parser_version).toBe(currentIdentity.parserVersions.xlsx);
    expect(currentIdentity.normalizationVersion).toBe(old.identity.normalizationVersion);
    console.info(
      JSON.stringify({
        xlsxEvidenceIdentityDiagnostic: {
          importedBuildId: old.buildId,
          freshBuildId: built.buildId,
          freshBuildMatchesImportedId: built.buildId === old.buildId,
          oldParserVersion: old.identity.parserVersions.xlsx,
          freshParserVersion: currentIdentity.parserVersions.xlsx,
        },
      }),
    );
    // A global build-ID difference would not by itself prove the XLSX contract.
    expect(currentIdentity.parserVersions.xlsx).not.toBe(old.identity.parserVersions.xlsx);
  });
});
