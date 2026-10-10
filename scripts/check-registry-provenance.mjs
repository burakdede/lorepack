#!/usr/bin/env node
// Checks that a published `@lorepack/cli` version is bound to its git tag (#619).
//
// The package's `gitHead` must be the tag's commit, and its SLSA provenance attestation must
// name this repository, `release.yml`, and that same commit as its source, for a subject whose
// digest is the published tarball. `npm audit signatures`, run beside this in the smoke
// workflow, verifies the attestation's signature; this checks what the signed statement says.
//
// Usage: node scripts/check-registry-provenance.mjs <version>   (run inside a git checkout
// that has the `v<version>` tag)
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE = '@lorepack/cli';
export const REPOSITORY = 'https://github.com/burakdede/lorepack';
export const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';

/** The hex sha512 inside an npm `sha512-<base64>` integrity string. */
export function integrityHex(integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error(`unexpected dist.integrity ${integrity}`);
  }
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
}

/**
 * Every problem with one version's registry metadata and attestation bundle, given the tag's
 * commit. Pure, so a test can hand it any registry response.
 */
export function provenanceProblems({ version, manifest, attestations, tagCommit }) {
  const problems = [];
  const id = `${PACKAGE}@${version}`;

  if (manifest.gitHead !== tagCommit) {
    problems.push(
      `${id} gitHead is ${manifest.gitHead ?? 'missing'}, but tag v${version} is ${tagCommit}`,
    );
  }

  const entry = (attestations?.attestations ?? []).find((item) => item.predicateType === SLSA);
  if (entry === undefined) {
    problems.push(`${id} has no SLSA provenance attestation`);
    return problems;
  }

  let statement;
  try {
    statement = JSON.parse(
      Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
    );
  } catch (error) {
    problems.push(`${id} provenance payload is unreadable: ${error.message}`);
    return problems;
  }

  const expectedDigest = integrityHex(manifest.dist?.integrity);
  const subject = statement.subject?.find((item) => item.name === `pkg:npm/${id}`);
  if (subject?.digest?.sha512 !== expectedDigest) {
    problems.push(`${id} provenance subject does not match the published tarball digest`);
  }

  const build = statement.predicate?.buildDefinition;
  const source = build?.resolvedDependencies?.[0];
  if (source?.digest?.gitCommit !== tagCommit) {
    problems.push(
      `${id} provenance source commit is ${source?.digest?.gitCommit ?? 'missing'}, not ${tagCommit}`,
    );
  }
  if (build?.externalParameters?.workflow?.repository !== REPOSITORY) {
    problems.push(
      `${id} provenance names repository ${build?.externalParameters?.workflow?.repository}`,
    );
  }
  if (build?.externalParameters?.workflow?.path !== WORKFLOW) {
    problems.push(`${id} provenance names workflow ${build?.externalParameters?.workflow?.path}`);
  }
  return problems;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function main() {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('usage: check-registry-provenance.mjs <version>');
    process.exit(1);
  }
  const viewed = JSON.parse(
    execFileSync(npmCommand(), ['view', `${PACKAGE}@${version}`, '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  );
  // npm 12 prints a one-element array for an exact version; npm 11 prints the object.
  const manifest = Array.isArray(viewed) ? viewed[0] : viewed;
  const tagCommit = execFileSync('git', ['rev-parse', `refs/tags/v${version}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  const url = manifest.dist?.attestations?.url;
  const attestations =
    typeof url === 'string' && url.startsWith('https://registry.npmjs.org/')
      ? await (await fetch(url)).json()
      : undefined;

  const problems = provenanceProblems({ version, manifest, attestations, tagCommit });
  if (problems.length > 0) {
    console.error('registry provenance check failed:\n');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`${PACKAGE}@${version}: gitHead and SLSA provenance both name ${tagCommit}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) await main();
