import { describe, expect, it } from 'vitest';
import { observerDiagnosticLines, vitestBatches } from './evidence.js';

describe('observer diagnostic lines', () => {
  it('keeps only bounded observer failure records', () => {
    const record = `LOREPACK_OBSERVER_DIAGNOSTIC_FAILURE ${'x'.repeat(5000)}`;
    expect(
      observerDiagnosticLines(
        `other output\n${record}\n${record}\n${record}\n${record}\n${record}`,
      ),
    ).toEqual([
      record.slice(0, 4096),
      record.slice(0, 4096),
      record.slice(0, 4096),
      record.slice(0, 4096),
    ]);
  });
});

describe('security evidence scheduling', () => {
  it('runs parser-limit workloads in their own Vitest process', () => {
    expect(
      vitestBatches([
        'packages/core/test/errors.test.ts',
        'packages/cli/test/parse-limits.test.ts',
        'packages/runtime/test/http.test.ts',
      ]),
    ).toEqual([
      ['packages/core/test/errors.test.ts', 'packages/runtime/test/http.test.ts'],
      ['packages/cli/test/parse-limits.test.ts'],
    ]);
  });

  it('keeps the normal evidence files in one batch', () => {
    expect(vitestBatches(['packages/core/test/errors.test.ts'])).toEqual([
      ['packages/core/test/errors.test.ts'],
    ]);
  });
});
