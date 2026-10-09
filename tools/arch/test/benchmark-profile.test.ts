import { describe, expect, it } from 'vitest';
import { parseOptions } from '../../../scripts/bench-corpus.mjs';

describe('corpus benchmark profiles', () => {
  it('selects one scale and an edge-case profile', () => {
    expect(parseOptions(['--scale', 'medium', '--edge-case', 'unsupported'])).toEqual({
      scale: 'medium',
      edgeCase: 'unsupported',
      tiers: ['medium'],
    });
  });

  it('runs every scale by default', () => {
    expect(parseOptions([]).tiers).toEqual(['small', 'medium', 'large']);
  });

  it('rejects unknown profiles', () => {
    expect(() => parseOptions(['--edge-case', 'vectors'])).toThrow(/--edge-case/);
  });
});
