import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalSmokeEnvironment } from '../../../scripts/check-global-smoke.mjs';
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
      assertCommandSucceeded({ status: 0, stdout: 'ok', stderr: '' }, ['lorepack', 'build']),
    ).not.toThrow();
    expect(() =>
      assertCommandSucceeded({ status: 1, stdout: '', stderr: 'broken' }, ['lorepack', 'build']),
    ).toThrow('lorepack build exited 1');
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

describe('disposable global smoke', () => {
  it('uses the real global install and preserves literal environment paths', () => {
    const prefix = 'global prefix & (literal) ^ %LOREPACK_LITERAL%';
    const temporary = 'project space & (literal) ^ %LOREPACK_LITERAL%';
    const original = {
      Path: 'original-path',
      NPM_CONFIG_PREFIX: 'user-global-prefix',
      LOREPACK_SMOKE_CLI: 'checkout-override.js',
      lorepack_smoke_cli: 'another-override.js',
      PRESERVED: 'unchanged',
    };
    const environment = globalSmokeEnvironment(prefix, temporary, original);
    expect(environment.PATH).toBe(
      `${process.platform === 'win32' ? prefix : join(prefix, 'bin')}${delimiter}original-path`,
    );
    expect(environment.npm_config_prefix).toBe(prefix);
    expect(environment.TMPDIR).toBe(temporary);
    expect(environment.TMP).toBe(temporary);
    expect(environment.TEMP).toBe(temporary);
    expect(environment.PRESERVED).toBe('unchanged');
    expect(
      Object.keys(environment).filter((key) => key.toLowerCase() === 'lorepack_smoke_cli'),
    ).toEqual([]);
    expect(
      Object.keys(environment).filter((key) => key.toLowerCase() === 'npm_config_prefix'),
    ).toEqual(['npm_config_prefix']);
    expect(original.NPM_CONFIG_PREFIX).toBe('user-global-prefix');
    expect(original.LOREPACK_SMOKE_CLI).toBe('checkout-override.js');
  });
});
