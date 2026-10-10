#!/usr/bin/env node
// Publishes the tarballs the release build job packed and checked, then makes the requested
// dist-tag point at them.
//
// It runs in the `publish` job, which holds the npm OIDC capability, so it uses node builtins
// only and reads everything it needs from the tarballs: no workspace, no install.
//
// A version that already exists is never skipped on its name alone (#619). Its registry
// `dist.integrity` must equal the local tarball's, or the run fails: a match means a retry of
// the same bytes, a mismatch means the registry holds something this commit did not build.
// After a match the dist-tag is moved, which is what makes a re-run that promotes a version
// to `latest` actually do so.
//
// Usage: node scripts/publish-packages.mjs --tag <latest|next> --tarballs <directory>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { runNpm } from './release-packages.mjs';

export const CHANNELS = ['latest', 'next'];

export function parseArgs(args) {
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const tag = value('--tag');
  const tarballs = value('--tarballs');
  if (args.length !== 4 || tag === undefined || tarballs === undefined) {
    throw new Error('usage: publish-packages.mjs --tag <latest|next> --tarballs <directory>');
  }
  if (!CHANNELS.includes(tag)) {
    throw new Error(`unknown npm channel "${tag}": expected ${CHANNELS.join(' or ')}`);
  }
  return { tag, tarballs };
}

/** `latest` is what a plain `npm install` resolves, so it never carries a prerelease. */
export function assertChannelAllowed(version, tag) {
  if (tag === 'latest' && version.includes('-')) {
    throw new Error(`refusing to tag prerelease ${version} as latest: publish it to next`);
  }
}

/** The SRI string npm records as `dist.integrity` for exactly these tarball bytes. */
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** Reads `package/package.json` out of an npm tarball (gzip, then ustar). */
export function readPackedManifest(gzipped) {
  const tar = gunzipSync(gzipped);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0[\s\S]*$/, '');
    const prefix = field(345, 155);
    const name = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    offset += 512;
    if ((type === '0' || type === '') && name === 'package/package.json') {
      return JSON.parse(tar.subarray(offset, offset + size).toString('utf8'));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('tarball has no package/package.json');
}

function registryIntegrity(name, version, cwd, npm) {
  const result = npm(['view', `${name}@${version}`, 'dist.integrity', '--json'], cwd);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    if (/E404|404 Not Found|is not in this registry|No match found/i.test(output)) return null;
    throw new Error(`npm view failed for ${name}@${version}: ${output.trim()}`);
  }
  // npm prints nothing, successfully, for a version of an existing package that does not exist.
  const text = result.stdout.trim();
  if (text === '') return null;
  // npm 12 wraps a single field of an exact version in an array; npm 11 prints the string.
  const value = JSON.parse(text);
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Publishes one tarball, or confirms an earlier publish of the same bytes, then points `tag`
 * at it. Returns what it did, so a caller and a test can tell a publish from a retry.
 */
export function publishTarball({ tarball, tag, expectedGitHead, npm = runNpm }) {
  const bytes = readFileSync(tarball);
  const manifest = readPackedManifest(bytes);
  const { name, version } = manifest;
  const id = `${name}@${version}`;
  const cwd = resolve(tarball, '..');

  assertChannelAllowed(version, tag);
  if (expectedGitHead !== undefined && manifest.gitHead !== expectedGitHead) {
    throw new Error(
      `${id} was packed from ${manifest.gitHead ?? 'an unknown commit'}, not ${expectedGitHead}`,
    );
  }

  const local = integrityOf(bytes);
  let existing = registryIntegrity(name, version, cwd, npm);
  let action = 'confirmed';
  if (existing === null) {
    const published = npm(
      ['publish', resolve(tarball), '--access', 'public', '--tag', tag, '--provenance'],
      cwd,
    );
    process.stdout.write(published.stdout);
    process.stderr.write(published.stderr);
    if (published.status !== 0) {
      const output = `${published.stdout}\n${published.stderr}`;
      // A concurrent or interrupted run got there first: fall through to the integrity check.
      if (!/cannot publish over the previously published version/i.test(output)) {
        throw new Error(`npm publish failed for ${id}`);
      }
      existing = registryIntegrity(name, version, cwd, npm);
    } else {
      action = 'published';
      existing = local;
    }
  }

  if (existing !== local) {
    throw new Error(
      `${id} is already on the registry with integrity ${existing}, but this tarball is ${local}. Refusing to tag a different artifact.`,
    );
  }

  if (action === 'confirmed') {
    const tagged = npm(['dist-tag', 'add', id, tag], cwd);
    if (tagged.status !== 0) {
      throw new Error(`npm dist-tag add ${id} ${tag} failed: ${tagged.stderr || tagged.stdout}`);
    }
  }
  console.log(`${action} ${id} with integrity ${local}; ${tag} -> ${version}`);
  return { id, action, integrity: local };
}

function main() {
  const { tag, tarballs } = parseArgs(process.argv.slice(2));
  const expectedGitHead = process.env.RELEASE_COMMIT;
  if (!/^[0-9a-f]{40}$/.test(expectedGitHead ?? '')) {
    throw new Error('RELEASE_COMMIT must be the 40-character commit the tarballs were packed from');
  }
  const files = readdirSync(tarballs)
    .filter((file) => file.endsWith('.tgz'))
    .sort();
  if (files.length === 0) throw new Error(`no tarballs in ${tarballs}`);
  for (const file of files) {
    publishTarball({
      tarball: join(tarballs, file),
      tag,
      expectedGitHead,
    });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main();
