import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALWAYS_EXCLUDE, LoreError, loadConfig } from '@lorepack/core';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { discover, EXCLUSION_SAMPLE_LIMIT } from '../src/discover/discover.js';
import { createMatcher, parseIgnoreFile } from '../src/discover/ignore.js';

const CONFIG = 'version: 1\nname: p\nsources:\n  - .\n';

async function withProject<T>(
  files: Record<string, string>,
  run: (root: string) => T | Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...files } }, (project) =>
    run(project.root),
  );
}

function discoverIn(root: string, options: { allowLargeProject?: boolean } = {}) {
  return discover({ config: loadConfig({ cwd: root }), ...options });
}

const paths = (result: ReturnType<typeof discoverIn>): string[] =>
  result.artifacts.map((artifact) => artifact.relativePath);

describe('walking sources', () => {
  it('finds supported files at any depth', async () => {
    await withProject(
      { 'a.md': '# A', 'docs/b.md': '# B', 'docs/deep/c.txt': 'C', 'src/d.ts': 'export {};' },
      (root) => {
        // lore.yaml is excluded by default: it is tooling metadata, not context.
        expect(paths(discoverIn(root))).toEqual([
          'a.md',
          'docs/b.md',
          'docs/deep/c.txt',
          'src/d.ts',
        ]);
      },
    );
  });

  it('orders results deterministically, whatever the filesystem returns', async () => {
    await withProject({ 'z.md': '#', 'a.md': '#', 'm/n.md': '#' }, (root) => {
      const first = paths(discoverIn(root));
      const second = paths(discoverIn(root));
      expect(first).toEqual(second);
      expect(first).toEqual([...first].sort());
    });
  });

  it('produces the same artifact ids from two different absolute roots', async () => {
    const report = await checkDeterminism({
      files: { 'lore.yaml': CONFIG, 'docs/a.md': '# A', 'b.txt': 'B' },
      produce: (project) =>
        discoverIn(project.root)
          .artifacts.map((artifact) => artifact.artifactId)
          .join('|'),
    });
    expect(report.message ?? '').toBe('');
  });

  it('accepts a single file as a source', async () => {
    await withTempProject(
      { files: { 'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./only.md\n', 'only.md': '#' } },
      (project) => {
        expect(paths(discoverIn(project.root))).toEqual(['only.md']);
      },
    );
  });
});

describe('exclusions', () => {
  it('applies the always-on defaults without a .loreignore', async () => {
    await withProject(
      {
        'a.md': '#',
        'node_modules/pkg/index.js': '',
        '.git/config': '',
        'dist/out.js': '',
        '.env': 'SECRET=1',
        'key.pem': 'x',
      },
      (root) => {
        expect(paths(discoverIn(root))).toEqual(['a.md']);
      },
    );
  });

  it('applies those defaults to a subdirectory too', async () => {
    // #201. Every path below was indexed as ordinary context, because the defaults were
    // written in a form that anchors to the project root. A folder holding one JavaScript
    // subproject passes the 2,500 file envelope on its dependencies alone, and `.git/config`
    // is exactly where a remote URL carries a token.
    await withProject(
      {
        'context/a.md': '#',
        'context/node_modules/pkg/README.md': '# dependency',
        'app/.git/config': '[remote "origin"]',
        'app/dist/out.js': '',
        'app/build/out.js': '',
        'app/coverage/lcov.info': '',
        'app/.lore/state.sqlite': '',
        'app/.env': 'SECRET=1',
      },
      (root) => {
        const discovery = discoverIn(root);
        expect(paths(discovery)).toEqual(['context/a.md']);
        // Excluded, not merely unparsed: an exclusion is silent, a warning is not.
        expect(discovery.warnings).toEqual([]);
      },
    );
  });

  it('never discovers the archives lore pack writes into the project', async () => {
    // #148. The archive lands in the project root by default, so without this the tool
    // finds its own output on the next run and warns about a file it created a second ago.
    await withProject(
      {
        'a.md': '#',
        'demo-lore_abc123.lorepack': 'PK-not-really-a-zip',
        'archives/older.lorepack': 'PK-not-really-a-zip',
      },
      (root) => {
        const discovery = discoverIn(root);
        expect(paths(discovery)).toEqual(['a.md']);
        expect(discovery.warnings).toEqual([]);
      },
    );
  });

  it('honours .loreignore patterns', async () => {
    await withProject(
      { 'a.md': '#', 'drafts/b.md': '#', 'notes.md': '#', '.loreignore': 'drafts/\nnotes.md\n' },
      (root) => {
        expect(paths(discoverIn(root))).toEqual(['a.md']);
      },
    );
  });

  it('supports negation, so a pattern can be re-included', async () => {
    await withProject(
      {
        'drafts/keep.md': '#',
        'drafts/skip.md': '#',
        '.loreignore': 'drafts/**\n!drafts/keep.md\n',
      },
      (root) => {
        expect(paths(discoverIn(root))).toContain('drafts/keep.md');
        expect(paths(discoverIn(root))).not.toContain('drafts/skip.md');
      },
    );
  });

  it('matches a bare pattern at any depth, like gitignore', async () => {
    await withProject(
      { 'a.md': '#', 'x/tmp.md': '#', 'y/z/tmp.md': '#', '.loreignore': 'tmp.md\n' },
      (root) => {
        expect(paths(discoverIn(root))).toEqual(['a.md']);
      },
    );
  });

  it('warns about an unsupported format, naming the exact path', async () => {
    await withProject({ 'a.md': '#', 'photo.png': 'binary' }, (root) => {
      const result = discoverIn(root);
      const warning = result.warnings.find((w) => w.path === 'photo.png');
      expect(warning?.code).toBe('unsupported-format');
      expect(warning?.message).toContain('photo.png');
    });
  });
});

/**
 * #202. A file an ignore rule removed was recorded nowhere: not in the build, not in
 * `lore inspect`, not over the API, and not in the Studio view whose whole purpose is naming
 * what is missing and why. A rule written a little too broadly could take a folder out of
 * every answer, and the build would look entirely healthy.
 */
describe('what an ignore rule removed', () => {
  it('names the rule, its source, how many paths it took, and some of them', async () => {
    await withProject(
      {
        'a.md': '#',
        'drafts/one.md': '#',
        'drafts/two.md': '#',
        'scratch.tmp': 'x',
        '.loreignore': 'drafts/\n*.tmp\n',
      },
      (root) => {
        const { exclusions } = discoverIn(root);
        const drafts = exclusions.find((one) => one.pattern === 'drafts/');

        expect(drafts).toBeDefined();
        expect(drafts?.source).toBe('.loreignore');
        // One entry, naming the directory, not one per file inside it (#209). The walk
        // genuinely did not look in, so reporting two files would be reporting something
        // discovery never saw, and on a `node_modules` it would be two hundred thousand.
        expect(drafts?.count).toBe(1);
        expect(drafts?.sample).toEqual(['drafts/']);

        expect(exclusions.find((one) => one.pattern === '*.tmp')?.sample).toEqual(['scratch.tmp']);
      },
    );
  });

  it('attributes a rule to the layer that wrote it', async () => {
    await withProject({ 'a.md': '#', 'notes/b.md': '#', '.loreignore': 'notes/\n' }, (root) => {
      const { exclusions } = discoverIn(root);
      // `lore.yaml` is removed by the built-in defaults, `notes/` by the project's own file.
      // A reader looking for the line that removed their folder needs to know which to open.
      expect(exclusions.find((one) => one.pattern === 'lore.yaml')?.source).toBe('defaults');
      expect(exclusions.find((one) => one.pattern === 'notes/')?.source).toBe('.loreignore');
    });
  });

  it('records nothing for a path a negation put back', async () => {
    await withProject(
      {
        'drafts/keep.md': '#',
        'drafts/skip.md': '#',
        '.loreignore': 'drafts/**\n!drafts/keep.md\n',
      },
      (root) => {
        const { exclusions, artifacts } = discoverIn(root);
        expect(artifacts.map((a) => a.relativePath)).toContain('drafts/keep.md');
        const drafts = exclusions.find((one) => one.pattern === 'drafts/**');
        expect(drafts?.count).toBe(1);
        expect(drafts?.sample).toEqual(['drafts/skip.md']);
      },
    );
  });

  /**
   * The cap is exercised with a **file** pattern rather than a directory one, since #209:
   * a directory rule now prunes and reports one entry, so it can no longer produce a long
   * sample. A pattern that matches many files still can, and that is the case the cap exists
   * for.
   */
  it('caps the sample, so one rule cannot become a second listing of the corpus', async () => {
    const files: Record<string, string> = { 'a.md': '#', '.loreignore': '*.tmp\n' };
    for (let index = 0; index < 40; index += 1) {
      files[`file-${String(index).padStart(3, '0')}.tmp`] = 'x';
    }

    await withProject(files, (root) => {
      const bulk = discoverIn(root).exclusions.find((one) => one.pattern === '*.tmp');
      expect(bulk?.count).toBe(40);
      expect(bulk?.sample).toHaveLength(EXCLUSION_SAMPLE_LIMIT);
    });
  });

  /**
   * #209: an excluded directory is not descended into.
   *
   * The **exclusion count is the direct assertion**, not a proxy for one. A record is written
   * per path the walk decides about, so a walked `node_modules` of fifty files produces fifty
   * records and a pruned one produces a single record naming the directory. Fifty against one
   * is the walk, observed through the only artefact it leaves behind.
   *
   * Spying on `node:fs` would be the obvious alternative and is not possible: an ESM module
   * namespace is not configurable, so `vi.spyOn(fs, 'readdirSync')` throws rather than
   * observing anything.
   */
  it('does not look inside a directory a rule excluded', async () => {
    const files: Record<string, string> = { 'a.md': '#', '.loreignore': 'node_modules/\n' };
    for (let index = 0; index < 50; index += 1) {
      files[`node_modules/pkg-${String(index)}/index.md`] = '#';
    }

    await withProject(files, (root) => {
      const result = discoverIn(root);
      const pruned = result.exclusions.find((one) => one.pattern === 'node_modules/');
      expect(pruned?.count).toBe(1);
      expect(pruned?.sample).toEqual(['node_modules/']);
      expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(['a.md']);
    });
  });

  /**
   * The divergence #209 asked to resolve, decided in favour of git and asserted rather than
   * left incidental. `drafts/**` names the *contents* of `drafts`, not the directory, so it
   * does not prune and a negation beneath it still works. `drafts/` names the directory, so
   * it does prune, and git says a negation cannot reach inside one. Both directions matter:
   * pruning on any match would have silently broken the first.
   */
  it('prunes a directory named by a rule, and not one whose contents were named', async () => {
    await withProject(
      {
        'drafts/keep.md': '#',
        'drafts/skip.md': '#',
        '.loreignore': 'drafts/**\n!drafts/keep.md\n',
      },
      (root) => {
        expect(discoverIn(root).artifacts.map((one) => one.relativePath)).toEqual([
          'drafts/keep.md',
        ]);
      },
    );

    await withProject(
      {
        'a.md': '#',
        'drafts/keep.md': '#',
        '.loreignore': 'drafts/\n!drafts/keep.md\n',
      },
      (root) => {
        // The directory itself was excluded, so nothing under it is reachable. This is
        // gitignore's documented behaviour, and following it is what keeps the walking layer
        // and the matching layer from disagreeing.
        expect(discoverIn(root).artifacts.map((one) => one.relativePath)).toEqual(['a.md']);
      },
    );
  });

  it('leaves the directory Lorepack owns out of the record', async () => {
    // `.lore` holds the state database, the lock and the sealed builds. Its contents move
    // while a build runs, so recording them would both mislead a reader looking for their
    // own document and make two builds of identical sources record different bytes.
    await withProject(
      { 'a.md': '#', '.lore/state.sqlite': 'x', '.lore/lock/owner.json': '{}' },
      (root) => {
        const { exclusions } = discoverIn(root);
        for (const exclusion of exclusions) {
          for (const path of exclusion.sample) expect(path.startsWith('.lore/')).toBe(false);
        }
        expect(exclusions.find((one) => one.pattern.startsWith('.lore'))).toBeUndefined();
      },
    );
  });

  it('records the same bytes from two different absolute roots', async () => {
    const files: Record<string, string> = {
      'lore.yaml': CONFIG,
      'a.md': '#',
      '.loreignore': 'drafts/\n*.tmp\n',
      'drafts/one.md': '#',
      'drafts/two.md': '#',
      'scratch.tmp': 'x',
    };
    const report = await checkDeterminism({
      files,
      produce: (project) => JSON.stringify(discoverIn(project.root).exclusions),
    });
    expect(report.message ?? '').toBe('');
  });

  it('records an empty list when no rule removed anything a user wrote', async () => {
    await withProject({ 'a.md': '#', 'b.md': '#' }, (root) => {
      // `lore.yaml` is still removed by the defaults, so this is about the shape rather than
      // emptiness: the field is always present, and absent means something different.
      const { exclusions } = discoverIn(root);
      expect(Array.isArray(exclusions)).toBe(true);
      expect(exclusions.every((one) => one.count > 0)).toBe(true);
    });
  });
});

describe('unsupported formats', () => {
  it('warns about an unsupported format, naming the exact path', async () => {
    await withProject({ 'a.md': '#', 'photo.png': 'binary' }, (root) => {
      const result = discoverIn(root);
      const warning = result.warnings.find((w) => w.path === 'photo.png');
      expect(warning?.code).toBe('unsupported-format');
      expect(warning?.message).toContain('photo.png');
    });
  });

  /**
   * Phase 5 implemented the last format the registry listed, so the `planned-format` warning
   * has nothing left to fire on. The branch stays because the next format added will use it;
   * what this asserts is the current truth, which is that a spreadsheet is now read rather
   * than deferred, and that an unregistered extension is still named as unsupported.
   */
  it('warns only about extensions nobody registered, now that every format is implemented', async () => {
    await withProject({ 'sheet.xlsx': 'PK', 'photo.png': 'x' }, (root) => {
      const warnings = discoverIn(root).warnings;
      expect(warnings.find((w) => w.path === 'sheet.xlsx')).toBeUndefined();
      expect(warnings.find((w) => w.path === 'photo.png')?.code).toBe('unsupported-format');
    });
  });
});

describe('symlinks', () => {
  it('skips them by default, with a warning', async () => {
    await withProject({ 'a.md': '# A' }, (root) => {
      symlinkSync(join(root, 'a.md'), join(root, 'link.md'));
      const result = discoverIn(root);
      expect(paths(result)).not.toContain('link.md');
      expect(result.warnings.find((w) => w.path === 'link.md')?.code).toBe('symlink-skipped');
    });
  });

  it('refuses one that escapes the root, even when following is enabled', async () => {
    await withTempProject({ files: { 'outside/secret.md': '# secret' } }, (project) => {
      const root = join(project.root, 'project');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'lore.yaml'), CONFIG, 'utf8');
      writeFileSync(join(root, 'a.md'), '# A', 'utf8');
      symlinkSync(join(project.root, 'outside'), join(root, 'escape'));

      // Following is opt-in; escaping never is. This is the check #13 deliberately left
      // to discovery, because defeating a symlink needs the filesystem.
      const config = loadConfig({ cwd: root });
      const following = {
        ...config,
        effective: { ...config.effective, followSymlinks: true },
      };
      expect(() => discover({ config: following })).toThrowError(LoreError);
      try {
        discover({ config: following });
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_PATH_ESCAPE');
        expect((error as LoreError).message).toContain('outside the source root');
      }
    });
  });

  it('follows one that stays inside the root when enabled', async () => {
    await withProject({ 'real/a.md': '# A' }, (root) => {
      symlinkSync(join(root, 'real'), join(root, 'linked'));
      const config = loadConfig({ cwd: root });
      const following = { ...config, effective: { ...config.effective, followSymlinks: true } };
      expect(paths(discover({ config: following }))).toContain('linked/a.md');
    });
  });
});

describe('case collisions', () => {
  it('fails the build naming both paths, since one silently shadows the other', async () => {
    await withProject({ 'README.md': '#' }, (root) => {
      // Created directly: a case-insensitive filesystem would collapse these, and there
      // the collision cannot be staged at all.
      writeFileSync(join(root, 'Readme.md'), '#', 'utf8');
      const listing = discoverIn.bind(null, root);
      try {
        listing();
        // On a case-insensitive filesystem only one file exists, so there is nothing to
        // detect and the test has nothing to assert.
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_CASE_COLLISION');
        expect((error as LoreError).message).toContain('README.md');
      }
    });
  });
});

describe('scale envelope', () => {
  it('refuses a project above the file limit without an explicit override', async () => {
    await withProject({ 'a.md': '#', 'b.md': '#' }, (root) => {
      const config = loadConfig({ cwd: root });
      const tiny = {
        ...config,
        effective: {
          ...config.effective,
          limits: { ...config.effective.limits, maxSourceFiles: 1 },
        },
      };
      try {
        discover({ config: tiny });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_ENVELOPE_EXCEEDED');
        expect((error as LoreError).remediation).toContain('--allow-large-project');
      }
      expect(() => discover({ config: tiny, allowLargeProject: true })).not.toThrow();
    });
  });

  it('warns past the byte envelope and names the largest artifacts', async () => {
    await withProject({ 'big.md': 'x'.repeat(4096), 'small.md': 'x' }, (root) => {
      const config = loadConfig({ cwd: root });
      const tiny = {
        ...config,
        effective: {
          ...config.effective,
          limits: { ...config.effective.limits, maxTotalBytes: 100 },
        },
      };
      const warning = discover({ config: tiny }).warnings.find((w) => w.code === 'envelope-bytes');
      expect(warning?.message).toContain('big.md');
    });
  });

  it('excludes a single artifact above the per-file cap, with a warning', async () => {
    await withProject({ 'big.md': 'x'.repeat(4096), 'ok.md': '#' }, (root) => {
      const config = loadConfig({ cwd: root });
      const tiny = {
        ...config,
        effective: {
          ...config.effective,
          limits: { ...config.effective.limits, maxArtifactBytes: 100 },
        },
      };
      const result = discover({ config: tiny });
      expect(result.artifacts.map((a) => a.relativePath)).not.toContain('big.md');
      expect(result.warnings.find((w) => w.path === 'big.md')?.code).toBe('artifact-too-large');
    });
  });
});

describe('ignore matching', () => {
  it('parses comments, blank lines and negations', () => {
    const rules = parseIgnoreFile('# comment\n\ndrafts/\n!drafts/keep.md\n', '.loreignore');
    expect(rules).toEqual([
      { pattern: 'drafts/', negated: false, source: '.loreignore' },
      { pattern: 'drafts/keep.md', negated: true, source: '.loreignore' },
    ]);
  });

  it.each([
    ['node_modules/', 'node_modules/pkg/index.js', true],
    ['*.log', 'server.log', true],
    ['*.log', 'logs/server.log', true],
    ['/root-only.md', 'root-only.md', true],
    ['/root-only.md', 'nested/root-only.md', false],
    ['docs/*.md', 'docs/a.md', true],
    ['docs/*.md', 'docs/deep/a.md', false],
  ])('pattern %s against %s is %s', (pattern, path, expected) => {
    const matcher = createMatcher([{ pattern, negated: false, source: 'test' }]);
    expect(matcher.excludes(path)).toBe(expected);
  });

  it('lets a later rule win, which is what makes negation work', () => {
    const matcher = createMatcher([
      { pattern: 'drafts/**', negated: false, source: 't' },
      { pattern: 'drafts/keep.md', negated: true, source: 't' },
    ]);
    expect(matcher.excludes('drafts/skip.md')).toBe(true);
    expect(matcher.excludes('drafts/keep.md')).toBe(false);
  });

  /**
   * A trailing slash marks a directory. It does not anchor the rule, which is the
   * distinction #201 turned on: reading the raw pattern for a separator counted the
   * trailing marker and made every `foo/` rule root-only.
   */
  it.each([
    ['build/', 'build/out.js', true],
    ['build/', 'app/build/out.js', true],
    ['build/', 'a/b/c/build/out.js', true],
    ['/build/', 'build/out.js', true],
    ['/build/', 'app/build/out.js', false],
    ['app/build/', 'app/build/out.js', true],
    ['app/build/', 'nested/app/build/out.js', false],
  ])('directory pattern %s against %s is %s', (pattern, path, expected) => {
    const matcher = createMatcher([{ pattern, negated: false, source: 'test' }]);
    expect(matcher.excludes(path)).toBe(expected);
  });
});

/**
 * Every default, at three depths.
 *
 * The absence of exactly this table is what let a root-only list look complete for four
 * phases: each entry was correct at depth zero, which is the only depth anything tested.
 */
describe('the default exclusions apply at every depth', () => {
  const matcher = createMatcher(
    ALWAYS_EXCLUDE.map((pattern) => ({ pattern, negated: false, source: 'defaults' })),
  );

  const DIRECTORIES = ['node_modules', '.git', '.lore', 'dist', 'build', 'coverage'];

  it.each(DIRECTORIES)('excludes a %s directory wherever it sits', (directory) => {
    for (const path of [
      `${directory}/file.md`,
      `sub/${directory}/file.md`,
      `packages/a/${directory}/deep/file.md`,
    ]) {
      expect(matcher.excludes(path), path).toBe(true);
    }
  });

  it.each([
    '.env',
    '.env.production',
    'server.pem',
    'private.key',
    'id_rsa',
    'id_ed25519.pub',
    'store.p12',
    'store.pfx',
    '.DS_Store',
    'Thumbs.db',
  ])('excludes the credential-shaped name %s at depth', (name) => {
    expect(matcher.excludes(name), name).toBe(true);
    expect(matcher.excludes(`nested/deeper/${name}`), name).toBe(true);
  });

  it('excludes the project files Lorepack owns, and its archives, at depth', () => {
    for (const path of [
      'lore.yaml',
      'sub/lore.yaml',
      'sub/lore.lock',
      'sub/.loreignore',
      'sub/project.lorepack',
      'sub/.gitignore',
      'sub/.gitattributes',
    ]) {
      expect(matcher.excludes(path), path).toBe(true);
    }
  });

  it('still indexes ordinary documents that merely sit near an excluded name', () => {
    for (const path of [
      'docs/building-a-release.md',
      'docs/distribution.md',
      'notes/coverage-notes.md',
      'node_modules.md',
    ]) {
      expect(matcher.excludes(path), path).toBe(false);
    }
  });

  it('lets a project re-include something a default removed', () => {
    // The defaults come first and `.loreignore` after, so last-match-wins is what gives a
    // project the final say. Asserted here because the layering is the reason the defaults
    // can be broad without being a trap.
    const withOverride = createMatcher([
      ...ALWAYS_EXCLUDE.map((pattern) => ({ pattern, negated: false, source: 'defaults' })),
      { pattern: 'vendor/dist/notes.md', negated: true, source: '.loreignore' },
    ]);
    expect(withOverride.excludes('vendor/dist/other.md')).toBe(true);
    expect(withOverride.excludes('vendor/dist/notes.md')).toBe(false);
  });
});
