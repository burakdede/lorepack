import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const control = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(control, 'docs/testing/fixtures/original_cancellation');
const original = resolve(process.argv[2] ?? 'original');
const evidence = resolve('original-cancellation-evidence');
const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: original, encoding: 'utf8' }).trim();
const requireEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} does not match the pinned fixture`);
};

requireEqual(git('rev-parse', 'HEAD'), manifest.source, 'Source commit');
requireEqual(git('rev-parse', 'HEAD^{tree}'), manifest.tree, 'Source tree');
requireEqual(git('status', '--porcelain'), '', 'Clean original checkout');
const patch = readFileSync(join(fixture, 'diagnostics.patch'));
requireEqual(hash(patch), manifest.patchSha256, 'Passive patch');
execFileSync('git', ['apply', '--unidiff-zero', '--check', '--index', '-'], {
  cwd: original,
  input: patch,
});
execFileSync('git', ['apply', '--unidiff-zero', '--index', '-'], { cwd: original, input: patch });
const changed = git('diff', '--cached', '--name-only').split('\n').sort();
requireEqual(
  JSON.stringify(changed),
  JSON.stringify(Object.keys(manifest.files).sort()),
  'Changed paths',
);
for (const [path, expected] of Object.entries(manifest.files)) {
  requireEqual(hash(readFileSync(join(original, path))), expected, path);
}
requireEqual(git('diff', '--name-only'), '', 'Unstaged source');
mkdirSync(evidence, { recursive: true });
writeFileSync(
  join(evidence, 'provenance.json'),
  `${JSON.stringify(
    {
      ...manifest,
      controlCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: control,
        encoding: 'utf8',
      }).trim(),
      node: process.versions,
      platform: process.platform,
      architecture: process.arch,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runnerImage: process.env.ImageVersion ?? null,
      lockSha256: hash(readFileSync(join(original, 'pnpm-lock.yaml'))),
      qualification:
        'Historical diagnostic replay. A pass does not establish the original timeout cause.',
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(evidence, 'diagnostics.patch'), patch);
console.log(`Bound passive diagnostics to original source ${manifest.source}`);
