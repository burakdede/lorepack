import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedVerificationPassed } from './ci-aggregate-verification.mjs';

test('requires the docs gate for documentation-only changes', () => {
  assert.equal(
    selectedVerificationPassed({
      classifierResult: 'success',
      docsOnly: 'true',
      verifyResult: 'skipped',
      docsResult: 'success',
    }),
    true,
  );
});

test('rejects documentation-only changes when the docs gate skips or fails', () => {
  for (const docsResult of ['skipped', 'failure', 'cancelled']) {
    assert.equal(
      selectedVerificationPassed({
        classifierResult: 'success',
        docsOnly: 'true',
        verifyResult: 'skipped',
        docsResult,
      }),
      false,
      docsResult,
    );
  }
});

test('requires the full matrix for source changes', () => {
  assert.equal(
    selectedVerificationPassed({
      classifierResult: 'success',
      docsOnly: 'false',
      verifyResult: 'success',
      docsResult: 'skipped',
    }),
    true,
  );
});

test('rejects source changes when the matrix skips, fails, or is cancelled', () => {
  for (const verifyResult of ['skipped', 'failure', 'cancelled']) {
    assert.equal(
      selectedVerificationPassed({
        classifierResult: 'success',
        docsOnly: 'false',
        verifyResult,
        docsResult: 'skipped',
      }),
      false,
      verifyResult,
    );
  }
});

test('rejects a failed or skipped classifier', () => {
  for (const classifierResult of ['failure', 'skipped', 'cancelled']) {
    assert.equal(
      selectedVerificationPassed({
        classifierResult,
        docsOnly: 'true',
        verifyResult: 'skipped',
        docsResult: 'success',
      }),
      false,
      classifierResult,
    );
  }
});
