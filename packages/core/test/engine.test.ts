import { describe, expect, it } from 'vitest';
import { checkNodeVersion, parseNodeVersion, SUPPORTED_NODE_RANGE } from '../src/runtime/engine.js';

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
  it.each(['24.15.0', '24.18.1', '24.99.0'])('accepts %s', (version) => {
    expect(checkNodeVersion(version).supported).toBe(true);
  });

  it.each([
    ['22.14.0', 'too-old'],
    ['24.14.9', 'too-old'],
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

  it('explains why the floor is 24.15 rather than stating it bluntly', () => {
    expect(checkNodeVersion('24.14.9').message).toMatch(/authorizer|limits/i);
  });
});
