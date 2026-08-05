import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifestSchema, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { orderByTree, ordinalPath } from '../src/commands/inspect.js';
import { runBuild } from '../src/services/build.js';
import { run } from './helpers.js';

const CONFIG = 'version: 1\nname: demo\nsources:\n  - .\n';

const CORPUS = {
  'guides/deployment.md':
    '# Deployment\n\n## Rollback\n\nRollback restores the previous release.\n\n## Retention\n\nSix builds are kept.\n',
  'notes/meeting.txt': 'We discussed the deployment schedule.\n',
  // Two files that must show up as warnings rather than disappearing silently.
  'photo.png': 'not really an image',
  'notes.bin': 'PK',
};

async function builtProject<T>(
  body: (root: string, lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG, ...CORPUS } }, async (temp) => {
    await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
    return body(temp.root, (args) => run(['--cwd', temp.root, ...args]));
  });
}

describe('lore inspect warnings', () => {
  it('lists every exclusion grouped by class, with exact paths', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'warnings']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('photo.png');
      expect(result.stdout).toContain('notes.bin');
      expect(result.stdout).toContain('unsupported-file');
    });
  });

  it('counts warnings by class as JSON', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'inspect', 'warnings'])).stdout);
      expect(parsed.total).toBeGreaterThanOrEqual(2);
      expect(Object.keys(parsed.byClass).length).toBeGreaterThan(0);
      expect(parsed.warnings.every((warning: { message: string }) => warning.message !== '')).toBe(
        true,
      );
    });
  });

  it('says so plainly when a build excluded nothing', async () => {
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'a.md': '# A\n\nText.' } },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        const result = await run(['--cwd', temp.root, 'inspect', 'warnings']);
        expect(result.stdout).toContain('No warnings');
      },
    );
  });
});

/**
 * #202. The other half of "exactly what was not parsed", and the half that was missing.
 * `warnings` lists files the walk read and could not use; a file an ignore rule removed
 * produced no record at all, which is the more common reason a document is not in a build.
 */
describe('lore inspect exclusions', () => {
  it('names the rule, where it came from, and what it took', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          '.loreignore': 'drafts/\n',
          'a.md': '# A\n\nText.',
          'drafts/one.md': '# One',
          'drafts/two.md': '# Two',
        },
      },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        const result = await run(['--cwd', temp.root, 'inspect', 'exclusions']);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain('drafts/');
        expect(result.stdout).toContain('.loreignore');
        // The directory is reported once, not file by file (#209). Discovery prunes an
        // excluded directory and never looks inside, so naming `drafts/one.md` here would
        // report a path the walk never saw. On a `node_modules` it would be a listing of
        // somebody's dependency tree.
        expect(result.stdout).not.toContain('drafts/one.md');
      },
    );
  });

  it('reports it as JSON, with the exact count and a bounded sample', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          '.loreignore': 'drafts/\n',
          'a.md': '# A\n\nText.',
          'drafts/one.md': '# One',
        },
      },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        const parsed = JSON.parse(
          (await run(['--cwd', temp.root, '--json', 'inspect', 'exclusions'])).stdout,
        );

        expect(parsed.recorded).toBe(true);
        const drafts = parsed.exclusions.find(
          (one: { pattern: string }) => one.pattern === 'drafts/',
        );
        expect(drafts.count).toBe(1);
        expect(drafts.sample).toEqual(['drafts/']);
        expect(parsed.total).toBe(
          parsed.exclusions.reduce((sum: number, one: { count: number }) => sum + one.count, 0),
        );
      },
    );
  });

  it('reads it out of the sealed build, so it survives the sources', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': CONFIG,
          '.loreignore': 'drafts/\n',
          'a.md': '# A\n\nText.',
          'drafts/one.md': '# One',
        },
      },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        // The whole point of sealing it: the answer is a property of the build, not something
        // recomputed by walking a source tree that may no longer exist.
        rmSync(join(temp.root, 'drafts'), { recursive: true, force: true });

        const result = await run(['--cwd', temp.root, 'inspect', 'exclusions']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('drafts/');
      },
    );
  });
});

describe('lore inspect build', () => {
  it('shows counts, capabilities, versions and canonical roots', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'build']);

      expect(result.stdout).toContain('lexical-search');
      expect(result.stdout).toContain('canonical roots');
      expect(result.stdout).toMatch(/artifacts\s+[0-9a-f]{64}/);
      expect(result.stdout).toContain('(active)');
    });
  });

  it('emits the manifest itself as JSON', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'inspect', 'build'])).stdout);
      expect(buildManifestSchema.safeParse(parsed).success).toBe(true);
    });
  });
});

describe('lore inspect sources and artifacts', () => {
  it('lists every indexed artifact with its parser and chunk count', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'sources']);
      expect(result.stdout).toContain('guides/deployment.md');
      expect(result.stdout).toContain('notes/meeting.txt');
      expect(result.stdout).toContain('chunks');
    });
  });

  it('shows one artifact with its metadata and node outline', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'guides/deployment.md']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('markdown');
      expect(result.stdout).toContain('content hash');
      expect(result.stdout).toContain('structure');
      expect(result.stdout).toContain('Rollback');
    });
  });

  it('lists an artifact chunks with locators and token estimates', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'chunks', 'guides/deployment.md']);
      expect(result.stdout).toMatch(/guides\/deployment\.md:\d+-\d+/);
      expect(result.stdout).toContain('tokens');
    });
  });

  it('agrees in number when there is exactly one of something', async () => {
    // #167: the count of one is the only count that can catch this, and every existing
    // assertion used a corpus of three.
    await withTempProject(
      { files: { 'lore.yaml': CONFIG, 'solo.md': '# Solo\n\nOne short document.\n' } },
      async (temp) => {
        await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
        const lore = (args: string[]) => run(['--cwd', temp.root, ...args]);

        const sources = (await lore(['inspect', 'sources'])).stdout;
        expect(sources).toContain('1 artifact in');
        expect(sources).toContain('1 chunk,');
        expect(sources).not.toContain('1 artifacts');
        expect(sources).not.toContain('1 chunks');

        expect((await lore(['inspect', 'chunks', 'solo.md'])).stdout).toContain('1 chunk in');
      },
    );
  });

  it('lists the whole build when no path is given, as every other subject does', async () => {
    // #166: the bare subject looked up the empty string as an artifact and failed with
    // "No artifact matches ." plus suggestions for a word nobody typed.
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'chunks']);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/guides\/deployment\.md:\d+-\d+/);
      expect(result.stdout).toMatch(/notes\/meeting\.txt:\d+-\d+/);
      expect(result.stderr).not.toContain('No artifact matches');
    });
  });

  it('carries every chunk in the JSON, whatever the human listing shows', async () => {
    await builtProject(async (_root, lore) => {
      const parsed = JSON.parse((await lore(['--json', 'inspect', 'chunks'])).stdout) as {
        artifactId: string | null;
        chunks: unknown[];
      };

      expect(parsed.artifactId).toBeNull();
      expect(parsed.chunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('suggests near misses for a path that does not exist', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'deployment']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Did you mean');
      expect(result.stderr).toContain('guides/deployment.md');
    });
  });

  it('points at the source listing when nothing is close', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'nowhere/at/all.md']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore inspect sources');
    });
  });
});

describe('the node tree in `lore inspect <path>`', () => {
  // #149. `ordinal` is a node's position among its siblings, which is what node ids need
  // and is not a document position. Ordering by it across different parents put a
  // document's paragraphs ahead of the sections they belong to, and rendering depth from
  // the heading path put a leaf deeper than its own parent. The stored data was correct
  // throughout: this was always a display defect, which is why nothing else changed.
  const NESTED = {
    'lore.yaml': CONFIG,
    'guide.md':
      '# Onboarding\n\nIntro paragraph.\n\n## Access\n\nRequest access.\n\n### Portal\n\nUse the portal.\n\n## Buddy\n\nEveryone gets a buddy.\n',
  };

  async function tree<T>(body: (lore: (args: string[]) => ReturnType<typeof run>) => Promise<T>) {
    return withTempProject({ files: NESTED }, async (temp) => {
      await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
      return body((args) => run(['--cwd', temp.root, ...args]));
    });
  }

  it('renders every node under its real parent, in document order', async () => {
    await tree(async (lore) => {
      const result = await lore(['inspect', 'guide.md']);
      const structure = result.stdout
        .slice(result.stdout.indexOf('structure ('))
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() !== '');

      expect(structure).toEqual([
        '    document  Onboarding  line 1',
        '      section  Onboarding  line 1',
        '        paragraph    line 3',
        '        section  Access  line 5',
        '          paragraph    line 7',
        '          section  Portal  line 9',
        '            paragraph    line 11',
        '        section  Buddy  line 13',
        '          paragraph    line 15',
      ]);
    });
  });

  it('emits the same order as JSON, so a consumer sees the tree too', async () => {
    await tree(async (lore) => {
      const result = await lore(['--json', 'inspect', 'guide.md']);
      const nodes = (JSON.parse(result.stdout) as { nodes: Array<{ id: string }> }).nodes;

      expect(nodes.map((node) => node.id.split('#')[1])).toEqual([
        '0',
        '0.1',
        '0.1.1',
        '0.1.2',
        '0.1.2.1',
        '0.1.2.2',
        '0.1.2.2.1',
        '0.1.3',
        '0.1.3.1',
      ]);
    });
  });
});

describe('ordering nodes by their ordinal path', () => {
  it('sorts siblings numerically, not as text', () => {
    // The reason the id is parsed rather than compared as a string: lexicographically the
    // tenth sibling sorts before the second, so a document with ten sections would render
    // in an order no reader could explain.
    const rows = ['a#0.10', 'a#0.2', 'a#0.1', 'a#0'].map((id) => ({ id }));
    expect(orderByTree(rows).map((row) => row.id)).toEqual(['a#0', 'a#0.1', 'a#0.2', 'a#0.10']);
  });

  it('puts a parent before its children', () => {
    const rows = ['a#0.1.1', 'a#0.1', 'a#0.1.1.1', 'a#0.2'].map((id) => ({ id }));
    expect(orderByTree(rows).map((row) => row.id)).toEqual([
      'a#0.1',
      'a#0.1.1',
      'a#0.1.1.1',
      'a#0.2',
    ]);
  });

  it.each([
    ['demo:docs/a.md#0.1.2', [0, 1, 2]],
    ['demo:docs/a.md#0', [0]],
    ['no-hash-at-all', []],
  ] as const)('reads the ordinal path out of %s', (id, expected) => {
    expect(ordinalPath(id)).toEqual([...expected]);
  });
});

describe('inspection reads only build data', () => {
  it('still works after every source file is deleted', async () => {
    // Section 4.9: what the compiler decided has to stay visible without re-running it.
    await builtProject(async (root, lore) => {
      rmSync(join(root, 'guides'), { recursive: true, force: true });
      rmSync(join(root, 'notes'), { recursive: true, force: true });
      rmSync(join(root, 'photo.png'));
      rmSync(join(root, 'notes.bin'));

      expect((await lore(['inspect', 'warnings'])).code).toBe(0);
      expect((await lore(['inspect', 'sources'])).stdout).toContain('guides/deployment.md');
      expect((await lore(['inspect', 'guides/deployment.md'])).code).toBe(0);
      expect((await lore(['inspect', 'build'])).code).toBe(0);
    });
  });

  it('can inspect a build that is not the active one', async () => {
    await builtProject(async (root, lore) => {
      const first = JSON.parse((await lore(['--json', 'inspect', 'build'])).stdout);
      rmSync(join(root, 'notes'), { recursive: true, force: true });
      await runBuild({ config: loadConfig({ cwd: root }), progress: new ProgressBus() });

      const older = JSON.parse(
        (await lore(['--json', 'inspect', 'build', '--build', first.buildId])).stdout,
      );
      expect(older.buildId).toBe(first.buildId);
      expect(older.counts.artifacts).toBeGreaterThan(0);
    });
  });

  it('fails with a typed error for an unknown build', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'build', '--build', 'lore_ffffffff']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('LORE_E_BUILD_NOT_FOUND');
    });
  });
});

/**
 * Tables, end to end through the real command.
 *
 * The corpus above is deliberately table-free, so this builds its own project. That keeps
 * the "no tables in this build" case honest: it is the state every other test in this file
 * runs in, and a user with a Markdown-only project sees it.
 */
const TABLE_CORPUS = {
  'lore.yaml': CONFIG,
  'people.csv': 'staff_id,name,zip,salary\n0007,Ada,02139,120000\n0008,Alan,00501,115000\n',
};

describe('lore inspect tables', () => {
  it('lists the tables with their row counts and source paths', async () => {
    await withTempProject({ files: TABLE_CORPUS }, async (temp) => {
      await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
      const result = await run(['--cwd', temp.root, 'inspect', 'tables']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('people');
      expect(result.stdout).toContain('2 rows');
      expect(result.stdout).toContain('people.csv');
    });
  });

  it('shows one table by its source path, with the types it inferred', async () => {
    await withTempProject({ files: TABLE_CORPUS }, async (temp) => {
      await runBuild({ config: loadConfig({ cwd: temp.root }), progress: new ProgressBus() });
      const parsed = JSON.parse(
        (await run(['--cwd', temp.root, '--json', 'inspect', 'tables', 'people.csv'])).stdout,
      ) as {
        // The runtime port's own shape since #235, rather than a second one assembled by
        // this command, which is what let the two disagree about statistics.
        table: { columns: { name: string; sqlName: string; type: string }[] };
        metadata: Record<string, unknown>;
      };

      // The identifier columns stayed text; only the genuinely numeric one is an integer.
      expect(parsed.table.columns.map((column) => [column.name, column.type])).toEqual([
        ['staff_id', 'text'],
        ['name', 'text'],
        ['zip', 'text'],
        ['salary', 'integer'],
      ]);
      // The generated names come with it, because they are what a query has to address.
      expect(parsed.table.columns.map((column) => column.sqlName)).toEqual([
        'c_0_staff_id',
        'c_1_name',
        'c_2_zip',
        'c_3_salary',
      ]);
      // How it was read is recorded, so a type a user disagrees with can be argued about.
      expect(parsed.metadata.hasHeader).toBe(true);
    });
  });

  it('says plainly that a build has no tables rather than printing an empty list', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'tables']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('no tables');
    });
  });

  it('names the fix when a table id does not match', async () => {
    await builtProject(async (_root, lore) => {
      const result = await lore(['inspect', 'tables', 'nope.csv']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('lore inspect tables');
    });
  });
});

describe('a build that contains tables', () => {
  it('declares table-query, counts the rows, and hashes them into its identity', async () => {
    await withTempProject({ files: TABLE_CORPUS }, async (temp) => {
      const result = await runBuild({
        config: loadConfig({ cwd: temp.root }),
        progress: new ProgressBus(),
      });
      const manifest = buildManifestSchema.parse(
        JSON.parse(
          readFileSync(join(temp.root, '.lore', 'builds', result.buildId, 'manifest.json'), 'utf8'),
        ),
      );

      expect(result.counts.tables).toBe(1);
      expect(result.counts.tableRows).toBe(2);
      expect(manifest.capabilities).toContain('table-query');
      // Section 11.4: a row change must change the build id, so the root cannot be the
      // hash of an empty list the way it was before tables existed.
      expect(manifest.canonicalRoots.tables).not.toBe(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
    });
  });

  /**
   * The property that makes a table part of the build rather than beside it. Two projects
   * that differ only in one cell must be two different builds, or a deploy of the second
   * would be a no-op and the wrong data would stay live.
   */
  it('changes the build id when a single cell changes', async () => {
    const idFor = async (salary: string): Promise<string> =>
      withTempProject(
        {
          files: {
            ...TABLE_CORPUS,
            'people.csv': `staff_id,name,zip,salary\n0007,Ada,02139,${salary}\n`,
          },
        },
        async (temp) => {
          const built = await runBuild({
            config: loadConfig({ cwd: temp.root }),
            progress: new ProgressBus(),
          });
          return built.buildId;
        },
      );

    expect(await idFor('120000')).not.toBe(await idFor('120001'));
  });

  /**
   * Determinism across absolute paths, for the table root specifically. Everything else in
   * the build has this test already; tables are new content in the identity and could carry
   * a path into the hash through a locator without anyone noticing.
   */
  it('produces the same build id from two different absolute roots', async () => {
    const idFor = async (): Promise<string> =>
      withTempProject({ files: TABLE_CORPUS }, async (temp) => {
        const built = await runBuild({
          config: loadConfig({ cwd: temp.root }),
          progress: new ProgressBus(),
        });
        return built.buildId;
      });

    expect(await idFor()).toBe(await idFor());
  });
});
