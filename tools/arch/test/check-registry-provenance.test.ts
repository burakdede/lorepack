import { describe, expect, it } from 'vitest';
import { integrityHex, provenanceProblems } from '../../../scripts/check-registry-provenance.mjs';

/**
 * What the post-publish smoke asserts about a published version (#619): its `gitHead` and its
 * SLSA provenance both name the release tag's commit, for the tarball the registry serves.
 */

const TAG = 'c'.repeat(40);
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function attestations(overrides: { commit?: string; digest?: string; path?: string } = {}) {
  const statement = {
    subject: [
      {
        name: 'pkg:npm/@lorepack/cli@0.1.0',
        digest: { sha512: overrides.digest ?? integrityHex(INTEGRITY) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/burakdede/lorepack',
            path: overrides.path ?? '.github/workflows/release.yml',
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: overrides.commit ?? TAG } }],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
        },
      },
    ],
  };
}

const manifest = (gitHead?: string) => ({
  gitHead,
  dist: { integrity: INTEGRITY },
});

describe('provenanceProblems', () => {
  it('accepts a version whose gitHead and provenance both name the tag', () => {
    expect(
      provenanceProblems({
        version: '0.1.0',
        manifest: manifest(TAG),
        attestations: attestations(),
        tagCommit: TAG,
      }),
    ).toEqual([]);
  });

  it('reports the 0.1.0-alpha.0 shape: another commit and no attestation', () => {
    expect(
      provenanceProblems({
        version: '0.1.0',
        manifest: manifest('d'.repeat(40)),
        attestations: undefined,
        tagCommit: TAG,
      }),
    ).toEqual([
      `@lorepack/cli@0.1.0 gitHead is ${'d'.repeat(40)}, but tag v0.1.0 is ${TAG}`,
      '@lorepack/cli@0.1.0 has no SLSA provenance attestation',
    ]);
  });

  it('reports provenance for another commit, another tarball or another workflow', () => {
    const problems = provenanceProblems({
      version: '0.1.0',
      manifest: manifest(TAG),
      attestations: attestations({
        commit: 'e'.repeat(40),
        digest: '00',
        path: '.github/workflows/other.yml',
      }),
      tagCommit: TAG,
    });
    expect(problems).toEqual([
      '@lorepack/cli@0.1.0 provenance subject does not match the published tarball digest',
      `@lorepack/cli@0.1.0 provenance source commit is ${'e'.repeat(40)}, not ${TAG}`,
      '@lorepack/cli@0.1.0 provenance names workflow .github/workflows/other.yml',
    ]);
  });
});
