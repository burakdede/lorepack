import { describe, expect, it } from 'vitest';
import { observerDiagnosticLines } from './evidence.js';

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
