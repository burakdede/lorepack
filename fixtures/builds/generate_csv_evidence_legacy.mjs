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

const PRODUCER = '39f9cf3d544f919de3164b8c57a874942d03e8a0';
const TARBALL_SHA256 = 'ee0a1c47b42c47e858a1aca1e83a0d2d02ff57b29e33ae4502ee0d51befbbdc2';
const tarball = process.argv[2];
const recipeSource = readFileSync(import.meta.filename, 'utf8');
if (tarball === undefined) {
  throw new Error('Pass the retained, qualified #596 CLI tarball as the sole argument.');
}
assert.equal(process.argv.length, 3);
assert.equal(process.version, 'v24.21.0');
assert.equal(process.versions.sqlite, '3.53.4');
assert.notEqual(
  process.platform,
  'win32',
  'Generate on POSIX; the sealed fixture runs on every OS.',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(readFileSync(tarball)), TARBALL_SHA256);
const npmCli = realpathSync(join(dirname(process.execPath), 'npm'));
const npmVersion = execFileSync(npmCli, ['--version'], { encoding: 'utf8' }).trim();
const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(npmVersion, '11.19.0');
assert.equal(pnpmVersion, '11.18.0');
const destination = join(import.meta.dirname, 'csv_evidence_legacy.lorepack');
const provenancePath = join(import.meta.dirname, 'csv_evidence_legacy.provenance.json');
assert.equal(existsSync(destination), false, 'Preserve the existing reviewed fixture.');
assert.equal(existsSync(provenancePath), false, 'Preserve the existing provenance receipt.');
const inputsPath = join(import.meta.dirname, 'csv_evidence_legacy_inputs.json');
const inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'lore-csv-evidence-legacy-'));
const commands = [];
try {
  const install = join(temporary, 'install');
  const project = join(temporary, 'project');
  mkdirSync(install);
  mkdirSync(project);
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
  for (const [path, content] of Object.entries(inputs)) {
    const full = join(project, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const built = cli('build');
  assert.equal(built.counts.tables, 1);
  assert.equal(built.counts.tableRows, 2);
  const directory = join(project, '.lore', 'builds', built.buildId);
  const identity = JSON.parse(
    readFileSync(join(directory, 'reports', 'build-id-inputs.json'), 'utf8'),
  );
  assert.equal(identity.parserVersions.csv, '0.1.1');
  assert.equal(identity.normalizationVersion, 2);
  const table = cli('inspect', 'tables', 'orders');
  assert.equal(table.metadata.tableEvidence, undefined);
  assert.equal(table.metadata.normalizationVersion, 1);
  const artifact = cli('inspect', 'docs/orders.csv');
  assert.equal(artifact.artifact.parser_version, '0.1.1');
  const archive = join(temporary, 'csv_evidence_legacy.lorepack');
  const packed = cli('pack', '--out', archive);
  assert.equal(packed.buildId, built.buildId);
  const verified = cli('pack', '--verify', archive);
  assert.equal(verified.ok, true);
  const provenance = {
    formatVersion: 1,
    producer: { head: PRODUCER, tarballSha256: TARBALL_SHA256 },
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
    inputsSha256: sha256(readFileSync(inputsPath)),
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([path, contents]) => [path, sha256(contents)]),
    ),
    archive: { buildId: built.buildId, sha256: sha256(readFileSync(archive)) },
    identity,
    originalDescription: table,
    originalArtifact: artifact,
    packVerification: verified,
    commands,
  };
  copyFileSync(archive, destination);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(
    JSON.stringify({ archive: destination, provenance: provenancePath, ...provenance.archive }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
