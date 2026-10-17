import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceArgument, outputArgument, expectedCommit] = process.argv.slice(2);
assert(sourceArgument && outputArgument && expectedCommit, 'Expected source, output and commit.');
assert.equal(process.versions.node, '24.21.0');
const source = realpathSync(sourceArgument);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
assert.equal(commit, expectedCommit);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const metadata = {
  qualification: 'Diagnostic capture only. A completed job is not a product cleanup pass.',
  commit,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }),
  recipeSha256: digest(import.meta.filename),
  sourceHashes: Object.fromEntries(
    [
      'packages/connect-clients/src/verify.ts',
      'packages/connect-clients/dist/verify.js',
      'packages/backend-local/src/lock.ts',
      'packages/backend-local/dist/lock.js',
      'pnpm-lock.yaml',
      'packages/connect-clients/node_modules/@modelcontextprotocol/client/dist/stdio.mjs',
      'packages/connect-clients/node_modules/@modelcontextprotocol/client/dist/index.mjs',
    ].map((path) => [path, digest(join(source, path))]),
  ),
  results: [],
};
const save = () =>
  writeFileSync(join(output, 'result.json'), `${JSON.stringify(metadata, null, 2)}\n`);
save();
if (process.platform === 'win32') {
  assert.equal(metadata.sourceStatus, '', 'Native evidence requires a clean pinned checkout.');
}
const { verifyStdioServer } = await import(
  pathToFileURL(join(source, 'packages/connect-clients/dist/verify.js'))
);
const { ProjectLock } = await import(
  pathToFileURL(join(source, 'packages/backend-local/dist/lock.js'))
);
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
for (const mode of ['direct', 'wrapper']) {
  const project = mkdtempSync(join(output, `${mode}-`));
  const records = join(project, 'pids');
  mkdirSync(records);
  const nonce = randomUUID();
  const lockPath = join(project, '.lore', 'lock');
  const fixture = join(project, 'server.mjs');
  writeFileSync(
    fixture,
    `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ProjectLock} from ${JSON.stringify(pathToFileURL(join(source, 'packages/backend-local/dist/lock.js')).href)};
const record = {nonce: ${JSON.stringify(nonce)}, pid: process.pid, ppid: process.ppid, acquired: false};
const file = join(${JSON.stringify(records)}, String(process.pid) + '.json');
writeFileSync(file, JSON.stringify(record));
const lock = new ProjectLock(${JSON.stringify(lockPath)}, {waitMs: 60000});
await lock.acquire();
record.acquired = true;
writeFileSync(file, JSON.stringify(record));
setInterval(() => {}, 1000);
`,
  );
  const wrapper = join(project, process.platform === 'win32' ? 'lorepack.cmd' : 'lorepack.sh');
  writeFileSync(
    wrapper,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\n${quote(process.execPath)} ${quote(fixture)}\nexit $?\n`,
    { mode: 0o755 },
  );
  const readRecords = () =>
    readdirSync(records).map((name) => {
      const record = JSON.parse(readFileSync(join(records, name), 'utf8'));
      assert.equal(record.nonce, nonce);
      assert(Number.isSafeInteger(record.pid) && record.pid > 0);
      assert(Number.isSafeInteger(record.ppid) && record.ppid > 0);
      return record;
    });
  const result = {
    mode,
    nonce,
    project,
    fixtureSha256: digest(fixture),
    wrapperSha256: digest(wrapper),
  };
  metadata.results.push(result);
  try {
    const started = performance.now();
    result.check = await verifyStdioServer({
      executable: mode === 'direct' ? process.execPath : wrapper,
      args: mode === 'direct' ? [fixture] : [],
      expected: async () => {
        throw new Error('A non-answering fixture must not reach expected-source verification.');
      },
      timeoutMs: 2000,
    });
    result.elapsedMs = performance.now() - started;
    assert.equal(result.check.ok, false);
    assert.equal(result.check.step, 'spawn');
    assert.match(result.check.detail, /timed out/);
    result.records = readRecords();
    assert(result.records.length > 0, 'No fixture PID: this is not cleanup evidence.');
    assert(
      result.records.some((record) => record.acquired),
      'No actual acquired lock.',
    );
    result.liveAfterReturn = result.records.filter((record) => alive(record.pid));
    try {
      result.lockOwnerAfterReturn = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      result.lockOwnerAfterReturn = null;
    }
    const lock = new ProjectLock(lockPath, { waitMs: 0 });
    try {
      await lock.acquire();
      result.lockAvailableAfterReturn = true;
    } catch (error) {
      assert.equal(error.code, 'LORE_E_LOCK_HELD');
      result.lockAvailableAfterReturn = false;
    } finally {
      lock.release();
    }
    result.observation =
      result.liveAfterReturn.length === 0 && result.lockAvailableAfterReturn
        ? 'cleanup-observed'
        : 'cleanup-defect-reproduced';
  } catch (error) {
    result.captureError = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    const owned = readRecords();
    for (const record of owned) {
      if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
    }
    for (let attempt = 0; attempt < 100 && owned.some((record) => alive(record.pid)); attempt++) {
      await delay(20);
    }
    result.liveAfterFixtureCleanup = owned.filter((record) => alive(record.pid));
    save();
    assert.deepEqual(result.liveAfterFixtureCleanup, []);
    const lock = new ProjectLock(lockPath, { waitMs: 0 });
    await lock.acquire();
    lock.release();
    result.lockAvailableAfterFixtureCleanup = true;
    save();
  }
}
const direct = metadata.results[0];
assert.deepEqual(direct.liveAfterReturn, [], 'The original direct-executable control regressed.');
assert.equal(direct.lockAvailableAfterReturn, true);
console.log(JSON.stringify(metadata, null, 2));
