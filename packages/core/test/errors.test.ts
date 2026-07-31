import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorCode, EXIT_CODES, exitCodeFor } from '../src/errors/codes.js';
import { causeChain, LoreError } from '../src/errors/lore-error.js';
import { REDACTED, redact, redactDeep, secretsFromEnv } from '../src/errors/redact.js';
import { renderAsJson, renderForCli, renderForProtocol } from '../src/errors/render.js';

describe('error codes', () => {
  it('maps every code to an exit code', () => {
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      expect(Object.values(EXIT_CODES)).toContain(exitCodeFor(code));
    }
  });

  it.each([
    ['LORE_E_CONFIG_INVALID', EXIT_CODES.USER],
    ['LORE_E_BUILD_VALIDATION', EXIT_CODES.BUILD],
    ['LORE_E_FTS5_UNAVAILABLE', EXIT_CODES.ENVIRONMENT],
    ['LORE_E_LOCK_HELD', EXIT_CODES.CONCURRENCY],
    ['LORE_E_REMOTE_DEPLOY', EXIT_CODES.REMOTE],
  ] as const)('%s exits %i', (code, exit) => {
    expect(exitCodeFor(code)).toBe(exit);
  });

  it('gives every code a human description', () => {
    for (const [code, description] of Object.entries(ERROR_CODES)) {
      expect(description.length, code).toBeGreaterThan(10);
    }
  });
});

describe('LoreError', () => {
  it('carries code, remediation, path, subject and exit code', () => {
    const error = new LoreError('LORE_E_PATH_ESCAPE', 'Path escapes the source root.', {
      remediation: 'Move the file inside ./project-context or remove the symlink.',
      path: 'archive/../../etc/passwd',
      subject: 'artifact:archive',
    });
    expect(error.code).toBe('LORE_E_PATH_ESCAPE');
    expect(error.exitCode).toBe(EXIT_CODES.USER);
    expect(error.codeDescription).toContain('outside');
    expect(LoreError.is(error)).toBe(true);
  });

  it('wraps unknown thrown values without losing them', () => {
    const wrapped = LoreError.from(new TypeError('boom'));
    expect(wrapped.code).toBe('LORE_E_INTERNAL');
    expect(wrapped.message).toBe('boom');
    expect(wrapped.cause).toBeInstanceOf(TypeError);
    expect(LoreError.from(LoreError.from('plain string')).message).toBe('plain string');
  });

  it('returns an existing LoreError unchanged', () => {
    const original = new LoreError('LORE_E_LOCK_HELD', 'held');
    expect(LoreError.from(original)).toBe(original);
  });

  it('walks the cause chain without looping', () => {
    const root = new Error('disk full');
    const mid = new LoreError('LORE_E_OBJECT_CORRUPT', 'object failed checksum', { cause: root });
    const top = new LoreError('LORE_E_BUILD_VALIDATION', 'candidate rejected', { cause: mid });
    expect(causeChain(top)).toEqual(['object failed checksum', 'disk full']);
  });
});

describe('redaction', () => {
  const secrets = ['super-secret-token-value'];

  it('removes a known secret from any rendering', () => {
    const error = new LoreError(
      'LORE_E_REMOTE_DEPLOY',
      'auth failed for super-secret-token-value',
      {
        remediation: 'Rotate super-secret-token-value and retry.',
        details: { header: 'Authorization: Bearer super-secret-token-value' },
      },
    );
    const cli = renderForCli(error, { secrets, verbose: true });
    const json = JSON.stringify(renderAsJson(error, { secrets }));
    const protocol = JSON.stringify(renderForProtocol(error, { secrets }));
    for (const output of [cli, json, protocol]) {
      expect(output).not.toContain('super-secret-token-value');
      expect(output).toContain(REDACTED);
    }
  });

  it('redacts token shapes it was never told about', () => {
    expect(redact('use ghp_abcdefghijklmnopqrstuvwxyz012345', [])).toContain(REDACTED);
    expect(redact('Authorization: Bearer abcdefghijklmnop', [])).toContain(REDACTED);
    expect(redact('API_KEY=abcdefghijklmnop', [])).toContain(REDACTED);
  });

  it('collects secret-shaped environment values only', () => {
    const found = secretsFromEnv({
      GITHUB_TOKEN: 'abcdefghijklmnop',
      HOME: '/home/someone',
      SHORT_SECRET: 'abc',
    });
    expect(found).toEqual(['abcdefghijklmnop']);
  });

  it('redacts nested structures', () => {
    const out = redactDeep({ a: [{ b: 'super-secret-token-value' }] }, secrets);
    expect(JSON.stringify(out)).not.toContain('super-secret-token-value');
  });
});

describe('renderers', () => {
  const error = new LoreError('LORE_E_FTS5_UNAVAILABLE', 'SQLite has no FTS5 module.', {
    remediation: 'Install an official Node build from nodejs.org.',
    path: 'lore.yaml',
    details: { sqliteVersion: '3.44.0' },
  });

  it('CLI output leads with the problem and ends with one next step', () => {
    const text = renderForCli(error, { secrets: [] });
    expect(text.split('\n')[0]).toContain('SQLite has no FTS5 module.');
    expect(text).toContain('code: LORE_E_FTS5_UNAVAILABLE');
    expect(text).toContain('path: lore.yaml');
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^next: /);
  });

  it('suggests doctor when no remediation was supplied', () => {
    const bare = new LoreError('LORE_E_INTERNAL', 'something broke');
    expect(renderForCli(bare, { secrets: [] })).toContain('lore doctor');
  });

  it('hides details unless verbose', () => {
    expect(renderForCli(error, { secrets: [] })).not.toContain('3.44.0');
    expect(renderForCli(error, { secrets: [], verbose: true })).toContain('3.44.0');
  });

  it('JSON output is stable and machine-readable', () => {
    const json = renderAsJson(error, { secrets: [] });
    expect(json.error.code).toBe('LORE_E_FTS5_UNAVAILABLE');
    expect(json.error.remediation).toContain('nodejs.org');
    expect(json.error.path).toBe('lore.yaml');
  });

  it('protocol output never leaks an absolute path', () => {
    const leaky = new LoreError('LORE_E_PARSE_FAILED', 'failed to parse /home/burak/secret/x.pdf', {
      remediation: 'Check the file at C:\\Users\\burak\\x.pdf',
    });
    const rendered = renderForProtocol(leaky, { secrets: [] });
    expect(rendered.message).not.toContain('/home/burak');
    expect(rendered.message).not.toContain('C:\\Users');
    expect(rendered.message).toContain('<path>');
  });
});
