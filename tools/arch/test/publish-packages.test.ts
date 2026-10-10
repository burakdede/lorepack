import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertChannelAllowed,
  integrityOf,
  parseArgs,
  publishTarball,
  readPackedManifest,
} from '../../../scripts/publish-packages.mjs';

/**
 * The npm publisher, against a stub npm (#619).
 *
 * The behaviour that matters is what it does when a version already exists: compare the
 * registry's integrity with the local tarball and move the dist-tag, rather than reporting
 * success on the version string alone.
 */

const COMMIT = 'a'.repeat(40);

/** A minimal npm tarball: one ustar entry, `package/package.json`, gzipped. */
function tarball(manifest: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512, 0);
  const write = (value: string, offset: number) => header.write(value, offset, 'utf8');
  write('package/package.json', 0);
  write('0000644\0', 100);
  write('0000000\0', 108);
  write('0000000\0', 116);
  write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  write('00000000000\0', 136);
  write('        ', 148);
  write('0', 156);
  write('ustar\0', 257);
  write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]));
}

interface Call {
  readonly args: readonly string[];
}

function stubNpm(registryIntegrity: string | null, options: { publishFails?: boolean } = {}) {
  const calls: Call[] = [];
  const npm = (args: readonly string[]) => {
    calls.push({ args });
    if (args[0] === 'view') {
      return registryIntegrity === null
        ? { status: 1, stdout: '', stderr: 'npm error code E404' }
        : { status: 0, stdout: JSON.stringify([registryIntegrity]), stderr: '' };
    }
    if (args[0] === 'publish') {
      return options.publishFails === true
        ? { status: 1, stdout: '', stderr: 'npm error code E403' }
        : { status: 0, stdout: '+ @lorepack/cli\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { npm, calls };
}

describe('publishTarball', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function packed(manifest: Record<string, unknown>): { path: string; integrity: string } {
    const root = mkdtempSync(join(tmpdir(), 'lore-publish-'));
    roots.push(root);
    const bytes = tarball(manifest);
    const path = join(root, 'lorepack-cli.tgz');
    writeFileSync(path, bytes);
    return { path, integrity: integrityOf(bytes) };
  }

  const cli = (version: string, gitHead = COMMIT) => ({
    name: '@lorepack/cli',
    version,
    gitHead,
  });

  it('publishes a new version with provenance on the requested tag', () => {
    const { path } = packed(cli('0.1.0'));
    const { npm, calls } = stubNpm(null);

    const result = publishTarball({ tarball: path, tag: 'latest', expectedGitHead: COMMIT, npm });

    expect(result.action).toBe('published');
    const publish = calls.find((call) => call.args[0] === 'publish');
    expect(publish?.args).toEqual([
      'publish',
      path,
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
    ]);
    expect(calls.some((call) => call.args[0] === 'dist-tag')).toBe(false);
  });

  it('moves the dist-tag when the same bytes are already published', () => {
    // The re-run that promotes 0.1.0 to latest: before #619 it printed "already published"
    // and changed nothing.
    const { path, integrity } = packed(cli('0.1.0'));
    const { npm, calls } = stubNpm(integrity);

    const result = publishTarball({ tarball: path, tag: 'latest', expectedGitHead: COMMIT, npm });

    expect(result.action).toBe('confirmed');
    expect(calls.some((call) => call.args[0] === 'publish')).toBe(false);
    expect(calls.find((call) => call.args[0] === 'dist-tag')?.args).toEqual([
      'dist-tag',
      'add',
      '@lorepack/cli@0.1.0',
      'latest',
    ]);
  });

  it('refuses to tag a registry version whose bytes differ from this tarball', () => {
    const { path } = packed(cli('0.1.0'));
    const { npm, calls } = stubNpm(`sha512-${Buffer.alloc(64, 1).toString('base64')}`);

    expect(() =>
      publishTarball({ tarball: path, tag: 'latest', expectedGitHead: COMMIT, npm }),
    ).toThrow('Refusing to tag a different artifact');
    expect(calls.some((call) => call.args[0] === 'dist-tag')).toBe(false);
    expect(calls.some((call) => call.args[0] === 'publish')).toBe(false);
  });

  it('refuses latest for a prerelease before touching the registry', () => {
    const { path } = packed(cli('0.1.0-rc.1'));
    const { npm, calls } = stubNpm(null);

    expect(() =>
      publishTarball({ tarball: path, tag: 'latest', expectedGitHead: COMMIT, npm }),
    ).toThrow('refusing to tag prerelease 0.1.0-rc.1 as latest');
    expect(calls).toEqual([]);
  });

  it('refuses a tarball packed from a different commit than the release', () => {
    const { path } = packed(cli('0.1.0', 'b'.repeat(40)));
    const { npm, calls } = stubNpm(null);

    expect(() =>
      publishTarball({ tarball: path, tag: 'next', expectedGitHead: COMMIT, npm }),
    ).toThrow(`not ${COMMIT}`);
    expect(calls).toEqual([]);
  });

  it('fails when npm publish fails, so no later job tags or releases', () => {
    const { path } = packed(cli('0.1.0'));
    const { npm } = stubNpm(null, { publishFails: true });

    expect(() =>
      publishTarball({ tarball: path, tag: 'next', expectedGitHead: COMMIT, npm }),
    ).toThrow('npm publish failed for @lorepack/cli@0.1.0');
  });
});

describe('publisher inputs', () => {
  it('reads the manifest out of a tarball', () => {
    expect(readPackedManifest(tarball(cli010()))).toEqual(cli010());
  });

  it.each([
    [['--tag', 'beta', '--tarballs', 'out'], 'unknown npm channel'],
    [['--tag', 'latest'], 'usage'],
  ])('rejects %j', (args, message) => {
    expect(() => parseArgs(args)).toThrow(message);
  });

  it('allows a prerelease on next and a stable version on either channel', () => {
    expect(() => assertChannelAllowed('0.1.0-rc.1', 'next')).not.toThrow();
    expect(() => assertChannelAllowed('0.1.0', 'latest')).not.toThrow();
    expect(() => assertChannelAllowed('0.1.0', 'next')).not.toThrow();
  });
});

function cli010() {
  return { name: '@lorepack/cli', version: '0.1.0', gitHead: COMMIT };
}
