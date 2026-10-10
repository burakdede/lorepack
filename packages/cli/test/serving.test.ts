import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  allowedHostsFor,
  isLoopback,
  parseInterval,
  parsePort,
  SERVE_DEFAULTS,
} from '../src/services/serving.js';

/**
 * The policy both servers share, asserted once.
 *
 * Architecture 15.3: never bind to all interfaces without an explicit flag and a warning.
 * The rule is enforced by `startServing` calling `isLoopback`, so what is worth pinning here
 * is which addresses count, because getting that wrong silently exposes a project.
 */

describe('what counts as loopback', () => {
  it('accepts the three spellings of this machine', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
  });

  it('rejects every address that reaches the network', () => {
    // `0.0.0.0` is the one that matters: it is what someone types when they mean "let me
    // reach this from my phone", and it is exactly the case 15.3 requires a warning for.
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('::')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
    expect(isLoopback('0.0.0.0:8080')).toBe(false);
    // Not a prefix match: a hostname that merely starts with a loopback spelling is not one.
    expect(isLoopback('localhost.example.com')).toBe(false);
    expect(isLoopback('127.0.0.1.example.com')).toBe(false);
  });
});

describe('refusing an argument that cannot mean what it says', () => {
  it('rejects ports outside the range, and says the range', () => {
    for (const bad of ['0', '65536', '-1', 'http', '80.5']) {
      expect(() => parsePort(bad), bad).toThrow(/port number/);
    }
  });

  it('accepts the ends of the range', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65_535);
    expect(parsePort(undefined)).toBe(SERVE_DEFAULTS.port);
  });

  it('rejects a revalidation interval that is not a duration', () => {
    for (const bad of ['-1', 'soon', '']) {
      expect(() => parseInterval(bad), bad).toThrow(/milliseconds/);
    }
    // Zero is meaningful: recheck on every request.
    expect(parseInterval('0')).toBe(0);
  });
});

/**
 * The `Host` names a server answers to, which is the DNS rebinding defence (#547).
 *
 * One list for REST and MCP, so the assertion is on the list rather than on either surface.
 */
describe('which Host names a server answers to', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1' }, { address: '::1' }],
    en0: [{ address: '192.168.0.162' }, { address: 'fe80::1c2b:3d4e', scopeid: 4 }],
  } as unknown as Record<string, NetworkInterfaceInfo[]>;

  it('is exactly the loopback names on a loopback bind', () => {
    for (const bind of ['127.0.0.1', 'localhost', '::1']) {
      expect(allowedHostsFor(bind, interfaces).sort(), bind).toEqual(
        ['127.0.0.1', '[::1]', 'localhost'].sort(),
      );
    }
  });

  it('adds an explicit non-loopback address, as a Host header carries it', () => {
    expect(allowedHostsFor('192.168.0.162', interfaces)).toContain('192.168.0.162');
    expect(allowedHostsFor('My-Box.LOCAL', interfaces)).toContain('my-box.local');
    expect(allowedHostsFor('FE80::1', interfaces)).toContain('[fe80::1]');
  });

  it("adds this machine's addresses on a wildcard bind, and never a hostname", () => {
    const hosts = allowedHostsFor('0.0.0.0', interfaces);
    expect(hosts).toContain('192.168.0.162');
    expect(hosts).toContain('[fe80::1c2b:3d4e]');
    expect(hosts).not.toContain('0.0.0.0');
    expect(allowedHostsFor('::', interfaces)).toContain('192.168.0.162');
  });

  it('refuses a bind host that is not an address', () => {
    expect(() => allowedHostsFor('not a host', interfaces)).toThrow(/--host must be an address/);
  });
});
