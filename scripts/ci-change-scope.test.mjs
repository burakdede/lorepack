import assert from 'node:assert/strict';
import test from 'node:test';
import { docsOnly } from './ci-change-scope.mjs';

test('recognizes supported product documentation paths', () => {
  assert.equal(
    docsOnly([
      'README.md',
      'docs/compatibility/performance-v0.1.md',
      'docs/images/studio-tour.mp4',
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.changeset/quiet-frogs-smile.md',
      'packages/core/README.md',
      'tools/acceptance/README.md',
    ]),
    true,
  );
});

test('keeps documentation renames scoped and sends cross-scope renames to full CI', () => {
  assert.equal(docsOnly(['docs/old-name.md', 'docs/new-name.md']), true);
  assert.equal(docsOnly(['README.md', 'packages/core/src/readme.ts']), false);
});

test('runs the full suite for product code, fixtures, examples, and workflow changes', () => {
  for (const path of [
    'packages/core/src/index.ts',
    'packages/cli/test/fixtures/guide.md',
    'examples/README.md',
    'fixtures/handbook.md',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'scripts/build-docs.mjs',
  ]) {
    assert.equal(docsOnly(['README.md', path]), false, path);
  }
});

test('treats an empty diff as full verification', () => {
  assert.equal(docsOnly([]), false);
});
