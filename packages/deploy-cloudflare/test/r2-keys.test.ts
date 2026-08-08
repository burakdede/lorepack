import { describe, expect, it } from 'vitest';
import { r2ArchiveKey, r2ObjectKey } from '../src/r2-keys.js';

const PROJECT = 'contracted';
const BUILD = `lore_${'a'.repeat(64)}`;
const HASH = 'f'.repeat(64);

describe('Cloudflare R2 key layout, issue 261', () => {
  it('stores normalized objects under the project-scoped shared prefix', () => {
    expect(r2ObjectKey(PROJECT, HASH)).toBe(
      `contracted/objects/sha256/${HASH.slice(0, 2)}/${HASH.slice(2, 4)}/${HASH.slice(4)}`,
    );
  });

  it('stores one sealed archive per build under the project build prefix', () => {
    expect(r2ArchiveKey(PROJECT, BUILD)).toBe(`${PROJECT}/builds/${BUILD}/archive.lorepack`);
  });

  it('changes archive keys across projects even for the same build id', () => {
    expect(r2ArchiveKey('other', BUILD)).not.toBe(r2ArchiveKey(PROJECT, BUILD));
  });
});
