import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { type Canonical, hashCanonical } from '../src/hash/canonical.js';

it('normalizes declared path patterns before effective configuration is hashed', async () => {
  const hashes: string[] = [];
  for (const spelling of ['café', 'cafe\u0301']) {
    await withTempProject(
      {
        files: {
          'lore.yaml': `version: 1\nname: patterns\nsources: [.]\nrules:\n  - match: "${spelling}/current.md"\n    supersedes: ["${spelling}/old.md"]\n`,
        },
      },
      ({ root }) => {
        const effective = loadConfig({ cwd: root }).effective;
        expect(effective.rules).toEqual([
          { match: 'café/current.md', supersedes: ['café/old.md'] },
        ]);
        hashes.push(hashCanonical(effective as unknown as Canonical));
      },
    );
  }
  expect(hashes).toHaveLength(2);
  expect(hashes[0]).toBe(hashes[1]);
});
