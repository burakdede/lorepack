import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDeterminism } from '../src/determinism.js';
import { canonicalJson, compareGolden, describeFirstDifference } from '../src/golden.js';
import { withTempProject } from '../src/temp-project.js';

describe('canonicalJson', () => {
  it('orders keys so a diff shows real changes', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toContain('[\n  3,\n  1,\n  2\n]');
  });
});

describe('compareGolden', () => {
  it('reports a missing golden with the command to create it', async () => {
    await withTempProject({}, (project) => {
      const result = compareGolden(project.path('expected/x.json'), { a: 1 });
      expect(result.matched).toBe(false);
      expect(result.message).toContain('UPDATE_FIXTURES=1');
    });
  });

  it('matches an identical golden', async () => {
    await withTempProject({ files: { 'expected/x.json': '{\n  "a": 1\n}\n' } }, (project) => {
      expect(compareGolden(project.path('expected/x.json'), { a: 1 }).matched).toBe(true);
    });
  });

  it('names the first differing line rather than dumping both files', async () => {
    await withTempProject({ files: { 'expected/x.json': '{\n  "a": 1\n}\n' } }, (project) => {
      const result = compareGolden(project.path('expected/x.json'), { a: 2 });
      expect(result.matched).toBe(false);
      expect(result.message).toContain('line 2');
      expect(result.message).toContain('"a": 1');
      expect(result.message).toContain('"a": 2');
    });
  });

  it('writes the golden in update mode', async () => {
    await withTempProject({}, (project) => {
      process.env.UPDATE_FIXTURES = '1';
      try {
        const target = project.path('expected/new.json');
        const result = compareGolden(target, { created: true });
        expect(result.written).toBe(true);
        expect(readFileSync(target, 'utf8')).toContain('"created": true');
      } finally {
        delete process.env.UPDATE_FIXTURES;
      }
    });
  });
});

describe('describeFirstDifference', () => {
  it('marks a line that runs off the end of the shorter file', () => {
    expect(describeFirstDifference('a\nb', 'a')).toContain('<missing>');
  });

  it('reports an empty line as empty rather than missing', () => {
    // A trailing newline produces an empty final element, which is a real difference
    // in content, not an absent line.
    const message = describeFirstDifference('a\nb\n', 'a\n');
    expect(message).toContain('line 2');
    expect(message).not.toContain('<missing>');
  });
});

describe('withTempProject', () => {
  it('creates a randomised absolute root and cleans up', async () => {
    let captured = '';
    await withTempProject({ files: { 'a/b.md': '# hello' } }, (project) => {
      captured = project.root;
      expect(existsSync(join(project.root, 'a', 'b.md'))).toBe(true);
    });
    expect(existsSync(captured)).toBe(false);
  });

  it('cleans up even when the callback throws', async () => {
    let captured = '';
    await expect(
      withTempProject({ files: { 'x.md': 'x' } }, (project) => {
        captured = project.root;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(captured)).toBe(false);
  });

  it('gives two calls different absolute roots', async () => {
    const roots: string[] = [];
    await withTempProject({}, (p) => void roots.push(p.root));
    await withTempProject({}, (p) => void roots.push(p.root));
    expect(roots[0]).not.toBe(roots[1]);
  });
});

describe('checkDeterminism', () => {
  const files = { 'a.md': '# A', 'b.md': '# B' };

  it('passes for a function of content alone', async () => {
    const report = await checkDeterminism({
      files,
      produce: (_project, order) => [...order].sort().join(','),
    });
    expect(report.deterministic).toBe(true);
    expect(report.results).toHaveLength(4);
  });

  it('detects dependence on the absolute path', async () => {
    const report = await checkDeterminism({ files, produce: (project) => project.root });
    expect(report.deterministic).toBe(false);
    expect(report.message).toContain('different absolute path');
  });

  it('detects dependence on enumeration order', async () => {
    const report = await checkDeterminism({ files, produce: (_p, order) => order.join(',') });
    expect(report.deterministic).toBe(false);
    expect(report.message).toContain('shuffled enumeration order');
  });

  it('detects a clock or counter leaking into output', async () => {
    let counter = 0;
    const report = await checkDeterminism({
      files,
      produce: () => {
        counter += 1;
        return String(counter);
      },
    });
    expect(report.deterministic).toBe(false);
  });
});
