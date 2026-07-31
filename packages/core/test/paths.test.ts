import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoreError } from '../src/errors/lore-error.js';
import {
  assertNoCaseCollisions,
  compareCanonical,
  findCaseCollisions,
  isInsideRoot,
  normalizeUnicode,
  sortCanonical,
  toCanonical,
  toDisplay,
  toPosix,
} from '../src/paths/canonical.js';
import {
  artifactId,
  chunkId,
  nodeId,
  normalizeSourceId,
  parseArtifactId,
} from '../src/paths/identifiers.js';

const POSIX_ROOT = '/home/someone/project';
const WINDOWS_ROOT = 'C:\\Users\\someone\\project';
const onWindows = sep === '\\';

describe('toPosix', () => {
  it.each([
    ['docs\\a\\b.md', 'docs/a/b.md'],
    ['docs/a/b.md', 'docs/a/b.md'],
    ['docs\\a/b.md', 'docs/a/b.md'],
    ['docs//a///b.md', 'docs/a/b.md'],
  ])('%s becomes %s', (input, expected) => {
    expect(toPosix(input)).toBe(expected);
  });
});

describe('toCanonical', () => {
  it('produces a POSIX relative path from a nested file', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const file = onWindows ? `${WINDOWS_ROOT}\\docs\\a\\b.md` : `${POSIX_ROOT}/docs/a/b.md`;
    expect(toCanonical(root, file)).toBe('docs/a/b.md');
  });

  it('gives the same identifier regardless of where the project lives', () => {
    const a = onWindows
      ? toCanonical('C:\\one\\project', 'C:\\one\\project\\docs\\x.md')
      : toCanonical('/one/project', '/one/project/docs/x.md');
    const b = onWindows
      ? toCanonical('D:\\somewhere\\else\\project', 'D:\\somewhere\\else\\project\\docs\\x.md')
      : toCanonical('/somewhere/else/project', '/somewhere/else/project/docs/x.md');
    expect(a).toBe(b);
    expect(a).toBe('docs/x.md');
  });

  it('contains no absolute prefix, drive letter, or native separator', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const file = onWindows ? `${WINDOWS_ROOT}\\a\\b.md` : `${POSIX_ROOT}/a/b.md`;
    const canonical = toCanonical(root, file);
    expect(canonical).not.toMatch(/^[A-Za-z]:/);
    expect(canonical).not.toContain('\\');
    expect(canonical.startsWith('/')).toBe(false);
  });

  it('resolves interior traversal that stays inside the root', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const file = onWindows ? `${WINDOWS_ROOT}\\docs\\..\\a.md` : `${POSIX_ROOT}/docs/../a.md`;
    expect(toCanonical(root, file)).toBe('a.md');
  });

  it('rejects a path that escapes the root', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const outside = onWindows ? 'C:\\Users\\someone\\secrets.env' : '/home/someone/secrets.env';
    expect(() => toCanonical(root, outside)).toThrowError(LoreError);
    try {
      toCanonical(root, outside);
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_PATH_ESCAPE');
      expect((error as LoreError).remediation).toBeDefined();
    }
  });

  it('rejects traversal that climbs out of the root', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const escaping = onWindows
      ? `${WINDOWS_ROOT}\\..\\..\\etc\\passwd`
      : `${POSIX_ROOT}/../../etc/passwd`;
    expect(() => toCanonical(root, escaping)).toThrowError(/outside the configured source root/);
  });

  it('rejects the root itself as an artifact', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    expect(() => toCanonical(root, root)).toThrowError(/cannot be the root/);
  });

  it.each([
    ['\\\\?\\C:\\project\\a.md', 'Device'],
    ['\\\\.\\pipe\\thing', 'Device'],
    ['\\\\server\\share\\a.md', 'UNC'],
  ])('rejects the exotic path %s', (input) => {
    expect(() => toCanonical(WINDOWS_ROOT, input)).toThrowError(LoreError);
  });

  it('normalizes decomposed unicode filenames to NFC', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const decomposed = normalizeUnicode('cafe\u0301.md').normalize('NFD');
    const file = onWindows ? `${WINDOWS_ROOT}\\${decomposed}` : `${POSIX_ROOT}/${decomposed}`;
    expect(toCanonical(root, file)).toBe('café.md');
  });
});

describe('isInsideRoot', () => {
  it('answers without throwing', () => {
    const root = onWindows ? WINDOWS_ROOT : POSIX_ROOT;
    const inside = onWindows ? `${WINDOWS_ROOT}\\a.md` : `${POSIX_ROOT}/a.md`;
    const outside = onWindows ? 'C:\\other\\a.md' : '/other/a.md';
    expect(isInsideRoot(root, inside)).toBe(true);
    expect(isInsideRoot(root, outside)).toBe(false);
  });
});

describe('toDisplay', () => {
  it('renders native separators for the user while ids stay POSIX', () => {
    expect(toDisplay('docs/a/b.md')).toBe(['docs', 'a', 'b.md'].join(sep));
  });
});

describe('ordering', () => {
  it('sorts by byte order, identically on every platform', () => {
    const input = ['b.md', 'A.md', 'a/b.md', 'a.md', 'Z.md', 'ä.md'];
    expect(sortCanonical(input)).toEqual(['A.md', 'Z.md', 'a.md', 'a/b.md', 'b.md', 'ä.md']);
  });

  it('does not use locale-aware comparison', () => {
    // localeCompare would order these the other way in most locales.
    expect(compareCanonical('Z.md', 'a.md')).toBeLessThan(0);
  });

  it('is stable regardless of input order', () => {
    const a = sortCanonical(['c.md', 'a.md', 'b.md']);
    const b = sortCanonical(['b.md', 'c.md', 'a.md']);
    expect(a).toEqual(b);
  });
});

describe('case collisions', () => {
  it('detects paths differing only by case and reports both', () => {
    const collisions = findCaseCollisions(['README.md', 'Readme.md', 'docs/a.md']);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.paths).toEqual(['README.md', 'Readme.md']);
  });

  it('ignores genuinely distinct paths', () => {
    expect(findCaseCollisions(['a.md', 'b.md', 'docs/a.md'])).toEqual([]);
  });

  it('treats an exactly repeated path as one entry, not a collision', () => {
    expect(findCaseCollisions(['a.md', 'a.md'])).toEqual([]);
  });

  it('throws a typed error naming both paths', () => {
    try {
      assertNoCaseCollisions(['Guide.md', 'guide.md']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LoreError).code).toBe('LORE_E_CASE_COLLISION');
      expect((error as LoreError).message).toContain('Guide.md');
      expect((error as LoreError).message).toContain('guide.md');
    }
  });
});

describe('identifiers', () => {
  it('derives an artifact id from source id and canonical path', () => {
    expect(artifactId('project-context', 'docs/a.md')).toBe('project-context:docs/a.md');
  });

  it('normalizes a messy source id', () => {
    expect(normalizeSourceId('  My Project/Context!  ')).toBe('my-project-context');
    expect(normalizeSourceId('***')).toBe('source');
  });

  it('produces identical ids for Windows and POSIX inputs', () => {
    expect(artifactId('src', toPosix('docs\\a\\b.md'))).toBe(artifactId('src', 'docs/a/b.md'));
  });

  it('builds node and chunk ids that are stable and parseable', () => {
    const artifact = artifactId('src', 'a.md');
    expect(nodeId(artifact, [0, 2, 1])).toBe('src:a.md#0.2.1');
    expect(chunkId(artifact, 3)).toBe('src:a.md@3');
    expect(parseArtifactId(artifact)).toEqual({ sourceId: 'src', relativePath: 'a.md' });
  });

  it.each(['', 'nocolon', ':leading', 'trailing:'])('rejects the malformed id %s', (id) => {
    expect(parseArtifactId(id)).toBeNull();
  });
});
