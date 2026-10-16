import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideRoot, toCanonical } from '../src/paths/canonical.js';

describe('parent components and ordinary dot-dot names', () => {
  const root = join(process.cwd(), 'source');

  it.each(['..notes.md', '..archive/old.md', '.../notes.md'])(
    'keeps the in-root name %s',
    (name) => {
      const absolute = join(root, ...name.split('/'));
      expect(toCanonical(root, absolute)).toBe(name);
      expect(isInsideRoot(root, absolute)).toBe(true);
    },
  );

  it.each(['../outside.md', '../source-sibling/notes.md', '../../outside.md'])(
    'rejects the escaping path %s',
    (name) => {
      const absolute = join(root, ...name.split('/'));
      expect(() => toCanonical(root, absolute)).toThrowError(
        expect.objectContaining({ code: 'LORE_E_PATH_ESCAPE' }),
      );
      expect(isInsideRoot(root, absolute)).toBe(false);
    },
  );
});
