import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = '2e41c031c6de642aa0100493b63c7d53ecd71b5b';

test('historical replay binds source, patch and resulting files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lorepack-original-replay-'));
  const checkout = join(temporary, 'original');
  const control = join(temporary, 'control');
  const fixture = join(control, 'docs/testing/fixtures/original_cancellation');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const reset = () => {
    execFileSync('git', ['reset', '--hard', source], { cwd: checkout, stdio: 'pipe' });
    execFileSync('git', ['clean', '-fd'], { cwd: checkout, stdio: 'pipe' });
  };
  const run = () =>
    spawnSync(
      process.execPath,
      [join(control, 'scripts/prepare-original-cancellation.mjs'), checkout],
      { cwd: temporary, encoding: 'utf8' },
    );
  try {
    git('worktree', 'add', '--detach', checkout, source);
    cpSync(
      join(root, 'scripts/prepare-original-cancellation.mjs'),
      join(control, 'scripts/prepare-original-cancellation.mjs'),
      { recursive: true },
    );
    cpSync(join(root, 'docs/testing/fixtures/original_cancellation'), fixture, { recursive: true });
    execFileSync('git', ['init'], { cwd: control, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: control, stdio: 'pipe' });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Bind replay fixture'], {
      cwd: control,
      stdio: 'pipe',
    });

    writeFileSync(join(checkout, 'unexpected-file'), 'dirty');
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Clean original checkout/);
    reset();

    execFileSync('git', ['checkout', '--detach', 'origin/main'], { cwd: checkout, stdio: 'pipe' });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Source commit/);
    reset();

    const patchPath = join(fixture, 'diagnostics.patch');
    const patch = readFileSync(patchPath);
    writeFileSync(patchPath, Buffer.concat([patch, Buffer.from('\n')]));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Passive patch/);
    writeFileSync(patchPath, patch);

    const manifestPath = join(fixture, 'manifest.json');
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText);
    manifest.files['packages/cli/test/dev.e2e.test.ts'] = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dev.e2e.test.ts does not match/);
    reset();
    writeFileSync(manifestPath, manifestText);

    result = run();
    assert.equal(result.status, 0, result.stderr);
    const provenance = JSON.parse(
      readFileSync(join(temporary, 'original-cancellation-evidence/provenance.json'), 'utf8'),
    );
    assert.equal(provenance.source, source);
    assert.equal(provenance.patchSha256, JSON.parse(manifestText).patchSha256);
    assert.equal(
      execFileSync('git', ['diff', '--name-only'], {
        cwd: checkout,
        encoding: 'utf8',
      }),
      '',
    );
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Clean original checkout/);
  } finally {
    git('worktree', 'remove', '--force', checkout);
    rmSync(temporary, { recursive: true, force: true });
  }
});
