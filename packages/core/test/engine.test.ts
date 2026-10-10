import { describe, expect, it } from 'vitest';
import {
  checkNodeVersion,
  checkSqliteVersion,
  MINIMUM_SQLITE_VERSION,
  parseNodeVersion,
  SUPPORTED_NODE_RANGE,
} from '../src/runtime/engine.js';

describe('parseNodeVersion', () => {
  it.each([
    ['24.15.0', { major: 24, minor: 15, patch: 0 }],
    ['v24.18.1', { major: 24, minor: 18, patch: 1 }],
    ['25.0.0-nightly', { major: 25, minor: 0, patch: 0 }],
  ])('parses %s', (input, expected) => {
    expect(parseNodeVersion(input)).toEqual(expected);
  });

  it.each(['', 'not-a-version', 'v24'])('rejects %s', (input) => {
    expect(parseNodeVersion(input)).toBeNull();
  });
});

describe('checkNodeVersion', () => {
  it.each(['24.19.0', '24.21.0', '24.99.0'])('accepts %s', (version) => {
    expect(checkNodeVersion(version).supported).toBe(true);
  });

  it.each([
    ['22.14.0', 'too-old'],
    ['24.14.9', 'too-old'],
    ['24.18.1', 'too-old'],
    ['23.11.0', 'too-old'],
    ['25.0.0', 'too-new'],
    ['banana', 'unparseable'],
  ] as const)('rejects %s as %s', (version, reason) => {
    const result = checkNodeVersion(version);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it('names the detected version, the supported range, and one upgrade instruction', () => {
    const result = checkNodeVersion('22.14.0');
    expect(result.message).toContain('22.14.0');
    expect(result.message).toContain(SUPPORTED_NODE_RANGE);
    expect(result.message).toContain('nodejs.org');
    // An actionable message, not a stack trace.
    expect(result.message).not.toContain('at Object.');
  });

  it('explains that the floor is the bundled SQLite, not version hygiene', () => {
    // 24.18.1 bundles SQLite 3.53.1, which carries the FTS5 memory-corruption CVEs.
    const message = checkNodeVersion('24.18.1').message ?? '';
    expect(message).toContain('3.53.2');
    expect(message).toContain('CVE-2026-11822');
  });
});

describe('checkSqliteVersion', () => {
  it('names 3.53.2 as the floor, the first release with the FTS5 fixes', () => {
    expect(MINIMUM_SQLITE_VERSION).toBe('3.53.2');
  });

  it.each(['3.53.2', '3.53.3', '3.53.4', '3.54.0', '4.0.0'])('accepts %s', (version) => {
    expect(checkSqliteVersion(version)).toEqual({ supported: true, detected: version });
  });

  it.each([
    ['3.53.1', 'too-old'],
    ['3.52.9', 'too-old'],
    ['3.45.0', 'too-old'],
    ['2.99.99', 'too-old'],
    ['3.53', 'unparseable'],
    ['', 'unparseable'],
  ] as const)('rejects %s as %s', (version, reason) => {
    const result = checkSqliteVersion(version);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.code).toBe('LORE_E_UNSUPPORTED_SQLITE');
  });

  it('names the detected version, the advisories, and an official build to install', () => {
    const message = checkSqliteVersion('3.53.1').message ?? '';
    expect(message).toContain('3.53.1');
    expect(message).toContain('3.53.2');
    expect(message).toContain('CVE-2026-11822');
    expect(message).toContain('CVE-2026-11824');
    expect(message).toContain('https://nodejs.org/en/download');
    expect(message).toContain('docs/compatibility/sqlite-fts5.md');
  });
});
