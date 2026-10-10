#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverPublishablePackages, ROOT, runNpm } from './release-packages.mjs';

// The tarballs `scripts/pack-cli.mjs` produced and `scripts/check-packed-cli.mjs` checked.
// Publishing a package directory instead would re-pack it without the bundled, tested
// dependency tree, and npm users would resolve `@napi-rs/canvas` again (#603).
const TARBALLS = join(ROOT, 'release-artifacts', 'npm');

const tag = parseTag(process.argv.slice(2));

function parseTag(args) {
  if (args.length !== 2 || args[0] !== '--tag' || !args[1]) {
    throw new Error('usage: publish-packages.mjs --tag <npm-dist-tag>');
  }
  return args[1];
}

function isPublished(name, version, cwd) {
  const result = runNpm(['view', `${name}@${version}`, 'version', '--json'], cwd);
  if (result.status === 0) return result.stdout.trim().replace(/^"|"$/g, '') === version;

  const output = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found|is not in this registry|No match found/i.test(output)) return false;
  throw new Error(`npm view failed for ${name}@${version}: ${output.trim()}`);
}

for (const packageJson of discoverPublishablePackages()) {
  const packageDir = packageJson.directory;

  const { name, version } = packageJson;
  if (isPublished(name, version, packageDir)) {
    console.log(`skipping ${name}@${version}: already published`);
    continue;
  }

  const tarball = join(TARBALLS, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
  if (!existsSync(tarball)) {
    throw new Error(`${tarball} is missing: run scripts/pack-cli.mjs before publishing`);
  }
  const result = runNpm(['publish', tarball, '--access', 'public', '--tag', tag], packageDir);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/cannot publish over the previously published version/i.test(output)) {
      console.log(`skipping ${name}@${version}: already published`);
      continue;
    }
    throw new Error(`npm publish failed for ${name}@${version}`);
  }
}
