import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  formula,
  makeXlsx,
  number,
  row,
  shared,
} from '../../tools/test-support/src/office-fixtures.ts';

const PRODUCER = 'c39e2b8ad38dd8181ca48ca6eadfd8a59e3fb0ed';
const [tarball, expectedSha256] = process.argv.slice(2);
const recipeSource = readFileSync(import.meta.filename, 'utf8');
if (tarball === undefined || expectedSha256 === undefined) {
  throw new Error('Pass the qualified C39 CLI tarball and its independently recorded SHA-256.');
}
assert.equal(process.argv.length, 4);
assert.match(expectedSha256, /^[0-9a-f]{64}$/);
assert.equal(process.version, 'v24.21.0');
assert.equal(process.versions.sqlite, '3.53.4');
assert.notEqual(
  process.platform,
  'win32',
  'Generate on POSIX; the sealed fixture runs on every OS.',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const actualTarSha256 = sha256(readFileSync(tarball));
assert.equal(actualTarSha256, expectedSha256);
const npmCli = realpathSync(join(dirname(process.execPath), 'npm'));
const npmVersion = execFileSync(npmCli, ['--version'], { encoding: 'utf8' }).trim();
const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(npmVersion, '11.19.0');
assert.equal(pnpmVersion, '11.18.0');

const config = 'version: 1\nname: xlsx-evidence-identity\nsources: [docs]\n';
const fixture = join(import.meta.dirname, 'xlsx_evidence_legacy.xlsx');
const archiveDestination = join(import.meta.dirname, 'xlsx_evidence_legacy.lorepack');
const provenancePath = join(import.meta.dirname, 'xlsx_evidence_legacy.provenance.json');
for (const path of [fixture, archiveDestination, provenancePath]) {
  assert.equal(existsSync(path), false, `Preserve the existing reviewed file: ${path}`);
}
const workbook = await makeXlsx({
  sharedStrings: ['item', 'computed', 'plain', 'A', 'B'],
  sheets: [
    {
      name: 'Rates',
      rows:
        row(1, [shared('A1', 0), shared('B1', 1), shared('C1', 2)]) +
        row(2, [shared('A2', 3), formula('B2', '1+1', 999), number('C2', 7)]) +
        row(3, [shared('A3', 4), number('B3', 3), number('C3', 8)]),
    },
  ],
});
const temporary = mkdtempSync(join(tmpdir(), 'lore-xlsx-evidence-legacy-'));
const commands = [];
try {
  const install = join(temporary, 'install');
  const project = join(temporary, 'project');
  mkdirSync(install);
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'lore.yaml'), config, 'utf8');
  writeFileSync(join(project, 'docs', 'rates.xlsx'), workbook);
  const execute = (executable, args, cwd) => {
    const stdout = execFileSync(executable, args, { cwd, encoding: 'utf8' });
    commands.push({ executable, args, cwd, stdout, exitCode: 0 });
    return stdout;
  };
  execute(
    npmCli,
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)],
    install,
  );
  const entry = join(install, 'node_modules', '@lorepack', 'cli', 'dist', 'public-entry.js');
  const cli = (...args) =>
    JSON.parse(execute(process.execPath, [entry, '--cwd', project, '--json', ...args], project));
  const built = cli('build');
  assert.equal(built.counts.tables, 1);
  assert.equal(built.counts.tableRows, 2);
  const directory = join(project, '.lore', 'builds', built.buildId);
  const identity = JSON.parse(
    readFileSync(join(directory, 'reports', 'build-id-inputs.json'), 'utf8'),
  );
  assert.equal(identity.parserVersions.xlsx, '0.1.3');
  assert.equal(identity.normalizationVersion, 2);
  const listed = cli('inspect', 'tables');
  assert.equal(listed.tables.length, 1);
  assert.equal(listed.tables[0].name, 'Rates');
  assert.equal(listed.tables[0].relativePath, 'rates.xlsx');
  const tableId = listed.tables[0].id;
  assert.equal(typeof tableId, 'string');
  const table = cli('inspect', 'tables', tableId);
  assert.equal(table.metadata.tableEvidence, undefined);
  assert.equal(table.metadata.normalizationVersion, 1);
  assert.equal(table.table.sample[0].computed, 999);
  assert.equal(table.table.sample[1].computed, 3);
  const artifact = cli('inspect', 'docs/rates.xlsx');
  assert.equal(artifact.artifact.parser_version, '0.1.3');
  const archive = join(temporary, 'xlsx_evidence_legacy.lorepack');
  const packed = cli('pack', '--out', archive);
  assert.equal(packed.buildId, built.buildId);
  const verified = cli('pack', '--verify', archive);
  assert.equal(verified.ok, true);
  const provenance = {
    formatVersion: 1,
    producer: { head: PRODUCER, tarballSha256: actualTarSha256 },
    runtime: {
      node: process.version,
      sqlite: process.versions.sqlite,
      nodeExecutable: process.execPath,
      npm: npmVersion,
      npmCli,
      pnpm: pnpmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    recipeSha256: sha256(recipeSource),
    recipeSource,
    config,
    configSha256: sha256(config),
    workbookSha256: sha256(workbook),
    tableId,
    archive: { buildId: built.buildId, sha256: sha256(readFileSync(archive)) },
    identity,
    originalDescription: table,
    originalArtifact: artifact,
    packVerification: verified,
    commands,
  };
  copyFileSync(archive, archiveDestination);
  writeFileSync(fixture, workbook);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(
    JSON.stringify({
      fixture,
      archive: archiveDestination,
      provenance: provenancePath,
      workbookSha256: provenance.workbookSha256,
      ...provenance.archive,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
