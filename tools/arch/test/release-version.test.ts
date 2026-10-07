import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stampReleaseVersion } from '../../../scripts/stamp-release-version.mjs';

function seedReleaseFixture(root: string): void {
  mkdirSync(join(root, 'packages', 'demo'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  writeFileSync(
    join(root, 'packages', 'demo', 'package.json'),
    JSON.stringify({ name: '@lorepack/demo', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'packages', 'demo', 'CHANGELOG.md'),
    '# @lorepack/demo\n\n' +
      '## 0.1.0\n\n' +
      '### Patch Changes\n\n' +
      '- Updated dependencies\n' +
      '  - @lorepack/core@0.1.0\n' +
      '  - @lorepack/old@0.1.0\n\n' +
      '## 0.0.1\n\n' +
      '- Historical dependency @lorepack/core@0.0.1\n',
  );
}

describe('release version stamping', () => {
  it('stamps alpha dependency references only in the new changelog section', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-release-'));
    try {
      seedReleaseFixture(root);
      stampReleaseVersion(root, '0.1.0-alpha.0');

      const manifest = JSON.parse(
        readFileSync(join(root, 'packages', 'demo', 'package.json'), 'utf8'),
      ) as { version: string };
      const changelog = readFileSync(join(root, 'packages', 'demo', 'CHANGELOG.md'), 'utf8');
      expect(manifest.version).toBe('0.1.0-alpha.0');
      expect(changelog).toContain('## 0.1.0-alpha.0');
      expect(changelog).toContain('@lorepack/core@0.1.0-alpha.0');
      expect(changelog).toContain('@lorepack/old@0.1.0-alpha.0');
      expect(changelog).toContain('Historical dependency @lorepack/core@0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps stable dependency references stable', () => {
    const root = mkdtempSync(join(tmpdir(), 'lorepack-release-'));
    try {
      seedReleaseFixture(root);
      stampReleaseVersion(root, '0.1.0');

      const changelog = readFileSync(join(root, 'packages', 'demo', 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('## 0.1.0');
      expect(changelog).toContain('@lorepack/core@0.1.0');
      expect(changelog).toContain('Historical dependency @lorepack/core@0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
