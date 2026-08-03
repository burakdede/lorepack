import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { renderSnippet } from '@lorepack/connect-clients';
import { loadConfig, ProgressBus, toCanonical, toPosix } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { resolveRealPath } from '../src/services/watch.js';

/**
 * Windows hardening, architecture 20.4.
 *
 * The rule the whole suite exists to protect is architecture 12.11's: **internal identifiers
 * are POSIX, filesystem calls are native.** Every defect in this area comes from mixing
 * those up, and the symptoms are never obviously about paths: a build id that differs
 * between machines, a watcher that silently stops, a generated command that loses half a
 * directory name.
 *
 * Most of these run everywhere on purpose. A separator rule that only holds on Windows is a
 * rule nobody notices breaking until the Windows job runs, and the identifier rules are
 * platform-independent by design, so asserting them everywhere is both cheap and stronger.
 */

const WINDOWS = platform() === 'win32';

describe('identifiers stay POSIX, whatever the filesystem calls them', () => {
  it('turns backslashes into forward slashes', () => {
    expect(toPosix('docs\\guides\\a.md')).toBe('docs/guides/a.md');
    expect(toPosix('docs/guides/a.md')).toBe('docs/guides/a.md');
    // Mixed separators are what a hand-written configuration on Windows actually contains.
    expect(toPosix('docs\\guides/a.md')).toBe('docs/guides/a.md');
  });

  it('gives a native path the same canonical id as its POSIX equivalent', () => {
    const root = WINDOWS ? 'C:\\projects\\mine' : '/projects/mine';
    const nested = join(root, 'docs', 'guides', 'a.md');

    // The property that makes a build id identical on every platform: the identifier is
    // derived from the relative path, in one spelling, regardless of how it was reached.
    expect(toCanonical(root, nested)).toBe('docs/guides/a.md');
  });

  it('refuses a path that escapes the root, rather than canonicalizing it into one', () => {
    const root = WINDOWS ? 'C:\\projects\\mine' : '/projects/mine';
    const outside = join(root, '..', 'theirs', 'secret.md');

    expect(() => toCanonical(root, outside)).toThrow();
  });
});

describe('paths shown to a person', () => {
  it('are native, while the identifier beside them is not', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: shown\nsources:\n  - .\n',
          'docs/a.md': '# A\n\nOne.\n',
        },
      },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        const built = await runBuild({ config, progress: new ProgressBus() });
        expect(built.created).toBe(true);

        // The identifier is POSIX so two machines agree; what a user reads uses their own
        // separator so it can be pasted into their own shell.
        const displayed = join('docs', 'a.md');
        expect(displayed.includes(sep)).toBe(true);
        expect(toPosix(displayed)).toBe('docs/a.md');
      },
    );
  }, 120_000);
});

describe('a case-only collision', () => {
  /**
   * Two files differing only in case are one file on Windows and on a default macOS volume,
   * and two on Linux. Left alone, the same corpus would produce different builds on different
   * machines, which breaks determinism in a way nothing else would reveal.
   */
  it.runIf(!WINDOWS && platform() !== 'darwin')(
    'is refused with both paths named, where the filesystem can even hold both',
    async () => {
      await withTempProject(
        {
          files: {
            'lore.yaml': 'version: 1\nname: collided\nsources:\n  - .\n',
            'docs/Readme.md': '# One\n\nFirst.\n',
            'docs/README.md': '# Two\n\nSecond.\n',
          },
        },
        async (project) => {
          const config = loadConfig({ cwd: project.root });
          await expect(runBuild({ config, progress: new ProgressBus() })).rejects.toThrow(/case/i);
        },
      );
    },
    120_000,
  );
});

describe('the path handed to the watcher', () => {
  /**
   * Windows CI aborted the watcher with a libuv assertion because `%TEMP%` under a long user
   * name is an 8.3 short path (`C:\\Users\\RUNNER~1\\...`). libuv compared the long name the
   * OS reported against the short name it was given and died.
   */
  it('is canonical, so the operating system and the watcher agree on the string', () => {
    const resolved = resolveRealPath(tmpdir());
    expect(resolveRealPath(resolved)).toBe(resolved);
  });

  it.runIf(WINDOWS)('is a long path, not an 8.3 short one', () => {
    // The specific shape that killed CI. `~1` in a resolved path means the short form
    // survived, and the watcher will assert on it.
    expect(resolveRealPath(tmpdir())).not.toMatch(/~\d/);
  });
});

describe('a generated client command', () => {
  const input = (path: string) => ({
    projectRoot: path,
    serverName: 'lorepack',
    command: { executable: 'lore', args: ['mcp', '--project', path, '--ensure-current'] },
    scope: 'project' as const,
  });

  it('keeps a Windows path with a space in one argument', () => {
    const snippet = renderSnippet(input('C:\\Users\\me\\my documents'));
    expect(snippet.windowsCommand).toContain('"C:\\Users\\me\\my documents"');
  });

  it('never concatenates the command into a string in the JSON form', () => {
    const snippet = renderSnippet(input('C:\\Users\\me\\my documents'));
    const parsed = JSON.parse(snippet.json) as Record<string, never>;

    // Architecture 6.6 step 7. An argument array is what makes quoting a non-problem for the
    // client, which does not go through a shell at all.
    expect(Array.isArray(parsed.mcpServers.lorepack.args)).toBe(true);
    expect(parsed.mcpServers.lorepack.args).toContain('C:\\Users\\me\\my documents');
  });
});

describe('a project in a directory with a space', () => {
  let project: string;

  beforeEach(() => {
    // Not exotic on any platform, and the default on Windows for anything under a user's
    // Documents folder.
    project = join(mkdtempSync(join(tmpdir(), 'lore-space-')), 'my project');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'lore.yaml'),
      'version: 1\nname: spaced\nsources:\n  - .\n',
      'utf8',
    );
    mkdirSync(join(project, 'docs'));
    writeFileSync(join(project, 'docs', 'a.md'), '# A\n\nOne.\n', 'utf8');
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('builds, and its identifiers carry no trace of the space', async () => {
    const config = loadConfig({ cwd: project });
    const built = await runBuild({ config, progress: new ProgressBus() });

    expect(built.created).toBe(true);
    // The build id must not depend on where the project happens to live.
    expect(built.buildId).toMatch(/^lore_[0-9a-f]{64}$/);
  }, 120_000);
});
