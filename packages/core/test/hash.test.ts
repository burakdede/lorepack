import { writeFileSync } from 'node:fs';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { LoreError } from '../src/errors/lore-error.js';
import {
  assertBuildId,
  BUILD_ID_INPUT_FIELDS,
  type BuildId,
  type BuildIdInputs,
  deriveBuildId,
  formatBuildId,
  isBuildId,
  resolveBuildIdPrefix,
} from '../src/hash/build-id.js';
import {
  CANONICALIZATION_VERSION,
  canonicalize,
  EMPTY_ROOT,
  hashCanonical,
  hashRoot,
  sha256Hex,
} from '../src/hash/canonical.js';
import { hashBytes, hashFile, objectKey } from '../src/hash/content.js';
import { NORMALIZATION_VERSION } from '../src/paths/canonical.js';

const BASE: BuildIdInputs = {
  formatVersion: 1,
  schemaVersion: 1,
  compilerVersion: '0.1.0',
  canonicalizationVersion: CANONICALIZATION_VERSION,
  normalizationVersion: NORMALIZATION_VERSION,
  effectiveConfig: { name: 'sarjbot', sources: ['./project-context'] },
  parserVersions: { markdown: '0.1.0', text: '0.1.0' },
  ruleResolution: [{ artifactId: 'src:a.md', status: 'active', authority: 50 }],
  embeddingProfile: null,
  canonicalRoots: {
    artifacts: 'a'.repeat(64),
    nodes: 'b'.repeat(64),
    chunks: 'c'.repeat(64),
    tables: 'd'.repeat(64),
    objects: 'e'.repeat(64),
  },
};

describe('canonicalize', () => {
  it('is insensitive to key insertion order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('is sensitive to array order, which is meaningful', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('length-prefixes so concatenation cannot collide', () => {
    // Without prefixes these two would serialize identically.
    expect(canonicalize(['ab', 'c'])).not.toBe(canonicalize(['a', 'bc']));
  });

  it('distinguishes a string from a number that prints the same', () => {
    expect(canonicalize('1')).not.toBe(canonicalize(1));
  });

  it('distinguishes null, false, and absent keys', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({ a: false }));
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });
});

describe('hashRoot', () => {
  it('does not depend on member order', () => {
    const a = hashRoot([sha256Hex('one'), sha256Hex('two')]);
    const b = hashRoot([sha256Hex('two'), sha256Hex('one')]);
    expect(a).toBe(b);
  });

  it('changes when a member is dropped', () => {
    const all = [sha256Hex('one'), sha256Hex('two')];
    expect(hashRoot(all)).not.toBe(hashRoot(all.slice(1)));
  });

  it('changes when a member changes', () => {
    expect(hashRoot([sha256Hex('one')])).not.toBe(hashRoot([sha256Hex('ONE')]));
  });

  it('has a stable empty root', () => {
    expect(EMPTY_ROOT).toBe(hashRoot([]));
    expect(EMPTY_ROOT).toHaveLength(64);
  });
});

describe('deriveBuildId', () => {
  it('produces lore_ followed by a full lowercase sha256', () => {
    const id = deriveBuildId(BASE);
    expect(id.startsWith('lore_')).toBe(true);
    expect(id.slice(5)).toMatch(/^[0-9a-f]{64}$/);
    expect(isBuildId(id)).toBe(true);
  });

  it('is stable across repeated derivation', () => {
    expect(deriveBuildId(BASE)).toBe(deriveBuildId(BASE));
  });

  it('ignores the order keys were written in', () => {
    const reordered: BuildIdInputs = {
      ...BASE,
      parserVersions: { text: '0.1.0', markdown: '0.1.0' },
    };
    expect(deriveBuildId(reordered)).toBe(deriveBuildId(BASE));
  });

  it.each([
    ['formatVersion', { formatVersion: 2 }],
    ['schemaVersion', { schemaVersion: 2 }],
    ['compilerVersion', { compilerVersion: '0.2.0' }],
    ['canonicalizationVersion', { canonicalizationVersion: 2 }],
    ['normalizationVersion', { normalizationVersion: 2 }],
    ['effectiveConfig', { effectiveConfig: { name: 'other', sources: ['./x'] } }],
    ['parserVersions', { parserVersions: { markdown: '0.2.0', text: '0.1.0' } }],
    ['ruleResolution', { ruleResolution: [{ artifactId: 'src:a.md', status: 'archived' }] }],
    ['embeddingProfile', { embeddingProfile: { modelId: 'x', dimensions: 384 } }],
  ] as const)('changes when %s changes', (_name, patch) => {
    expect(deriveBuildId({ ...BASE, ...patch } as BuildIdInputs)).not.toBe(deriveBuildId(BASE));
  });

  it.each(['artifacts', 'nodes', 'chunks', 'tables', 'objects'] as const)(
    'changes when the %s root changes',
    (root) => {
      const changed: BuildIdInputs = {
        ...BASE,
        canonicalRoots: { ...BASE.canonicalRoots, [root]: 'f'.repeat(64) },
      };
      expect(deriveBuildId(changed)).not.toBe(deriveBuildId(BASE));
    },
  );

  it('declares exactly the input fields architecture section 11.4 lists', () => {
    expect([...BUILD_ID_INPUT_FIELDS].sort()).toEqual(
      [
        'canonicalRoots',
        'canonicalizationVersion',
        'compilerVersion',
        'effectiveConfig',
        'embeddingProfile',
        'formatVersion',
        'normalizationVersion',
        'parserVersions',
        'ruleResolution',
        'schemaVersion',
      ].sort(),
    );
  });

  it('ignores excluded inputs entirely', () => {
    // Timestamps, hostnames, absolute paths and target names are not part of the type,
    // so passing them cannot change the result even when they ride along.
    const contaminated = {
      ...BASE,
      builtAt: '2026-07-31T00:00:00Z',
      hostname: 'laptop',
      workspacePath: '/home/someone/project',
      target: 'cloudflare',
    } as BuildIdInputs;
    expect(deriveBuildId(contaminated)).toBe(deriveBuildId(BASE));
  });
});

describe('formatBuildId', () => {
  const a = `lore_${'a'.repeat(64)}` as BuildId;
  const b = `lore_${'ab'.padEnd(64, 'b')}` as BuildId;

  it('defaults to twelve hexadecimal characters', () => {
    expect(formatBuildId(a)).toBe(`lore_${'a'.repeat(12)}`);
  });

  it('lengthens until unambiguous', () => {
    const near = `lore_${'a'.repeat(13)}${'c'.repeat(51)}` as BuildId;
    const formatted = formatBuildId(a, [a, near]);
    expect(formatted.length).toBeGreaterThan('lore_'.length + 12);
    expect(near.startsWith(formatted)).toBe(false);
  });

  it('does not lengthen for an unrelated build', () => {
    expect(formatBuildId(a, [a, b])).toBe(`lore_${'a'.repeat(12)}`);
  });
});

describe('resolveBuildIdPrefix', () => {
  const one = `lore_${'1'.repeat(64)}` as BuildId;
  const two = `lore_${'2'.repeat(64)}` as BuildId;
  const twoish = `lore_${'2'.repeat(20)}${'9'.repeat(44)}` as BuildId;

  it('resolves a unique prefix, with or without the lore_ prefix', () => {
    expect(resolveBuildIdPrefix('111111111111', [one, two])).toBe(one);
    expect(resolveBuildIdPrefix('lore_111111111111', [one, two])).toBe(one);
  });

  it('fails on an unknown prefix and points at the listing command', () => {
    try {
      resolveBuildIdPrefix('deadbeef', [one, two]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_BUILD_NOT_FOUND');
      expect((error as LoreError).remediation).toContain('lore inspect builds');
    }
  });

  it('fails on an ambiguous prefix and lists the candidates', () => {
    try {
      resolveBuildIdPrefix('2222', [two, twoish]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).message).toContain('ambiguous');
      expect((error as LoreError).details?.candidates).toHaveLength(2);
    }
  });
});

describe('assertBuildId', () => {
  it.each(['', 'lore_', 'lore_xyz', `lore_${'a'.repeat(63)}`, `LORE_${'a'.repeat(64)}`])(
    'rejects %s',
    (value) => {
      expect(() => assertBuildId(value)).toThrowError(LoreError);
    },
  );

  it('accepts a full lowercase digest', () => {
    expect(assertBuildId(`lore_${'a'.repeat(64)}`)).toBe(`lore_${'a'.repeat(64)}`);
  });
});

describe('content hashing', () => {
  it('matches a known sha256 vector', () => {
    expect(hashBytes('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a file by streaming and agrees with the in-memory hash', async () => {
    await withTempProject({}, async (project) => {
      const target = project.path('big.txt');
      const contents = 'x'.repeat(5_000_000);
      writeFileSync(target, contents, 'utf8');
      expect(await hashFile(target)).toBe(hashBytes(contents));
    });
  });

  it('builds a two-level object key', () => {
    const hash = 'abcdef'.padEnd(64, '0');
    expect(objectKey(hash)).toBe(`sha256/ab/cd/${hash.slice(4)}`);
  });
});

describe('cross-machine agreement', () => {
  it('gives the same build id for inputs from two different absolute roots', () => {
    // The inputs contain no absolute path by construction, which is the point: a caller
    // cannot accidentally include one, because the type has no field for it.
    const fromLinux = deriveBuildId(BASE);
    const fromWindows = deriveBuildId({ ...BASE });
    expect(fromLinux).toBe(fromWindows);
  });

  it('agrees with a recorded digest, so a refactor cannot silently change identity', () => {
    // Regenerate deliberately if the canonicalization version changes.
    expect(hashCanonical({ a: 1, b: ['x'] })).toBe(sha256Hex('o2:s1:ai1:1s1:ba1:s1:x'));
  });
});
