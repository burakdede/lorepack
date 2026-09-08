import { describe, expect, it } from 'vitest';
import {
  assertCommandSucceeded,
  assertExportResult,
  assertSearchResult,
  parseReleaseVersion,
} from '../../../scripts/public-registry-smoke.mjs';

describe('public registry smoke assertions', () => {
  it('accepts stable and prerelease versions and rejects shell-shaped input', () => {
    expect(parseReleaseVersion('v0.1.0')).toBe('0.1.0');
    expect(parseReleaseVersion('0.1.0-rc.1')).toBe('0.1.0-rc.1');
    expect(() => parseReleaseVersion('0.1.0; touch compromised')).toThrow(
      'invalid release version',
    );
  });

  it('turns command failures into failed smoke results', () => {
    expect(() =>
      assertCommandSucceeded({ status: 0, stdout: 'ok', stderr: '' }, ['lore', 'build']),
    ).not.toThrow();
    expect(() =>
      assertCommandSucceeded({ status: 1, stdout: '', stderr: 'broken' }, ['lore', 'build']),
    ).toThrow('lore build exited 1');
  });

  it('requires complete provenance on every search hit', () => {
    expect(() =>
      assertSearchResult({ hits: [{ locator: { artifactId: 'a', relativePath: 'runbook.md' } }] }),
    ).not.toThrow();
    expect(() =>
      assertSearchResult({ hits: [{ locator: { relativePath: 'runbook.md' } }] }),
    ).toThrow('without complete provenance');
  });

  it('requires citations in exported context', () => {
    expect(() =>
      assertExportResult({ buildId: 'lore_a', citations: [{ relativePath: 'runbook.md' }] }),
    ).not.toThrow();
    expect(() => assertExportResult({ buildId: 'lore_a', citations: [] })).toThrow(
      'no cited context',
    );
  });
});
