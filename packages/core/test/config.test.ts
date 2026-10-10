import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { checkDeterminism, withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { PRODUCT_DEFAULTS } from '../src/config/defaults.js';
import { findProjectRoot, loadConfig } from '../src/config/load.js';
import { LoreError } from '../src/errors/lore-error.js';

const MINIMAL = 'version: 1\nname: sarjbot\nsources:\n  - ./docs\n';

/** A project with a config file and a docs directory, the shape `lorepack init` produces. */
async function withProject<T>(
  files: Record<string, string>,
  run: (root: string) => T | Promise<T>,
): Promise<T> {
  return withTempProject({ files: { 'docs/.keep': '', ...files } }, async (project) =>
    run(project.root),
  );
}

describe('findProjectRoot', () => {
  it('finds the config in the starting directory', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      expect(findProjectRoot(root)).toBe(root);
    });
  });

  it('walks up from a nested directory', async () => {
    await withProject({ 'lore.yaml': MINIMAL, 'docs/deep/nested/.keep': '' }, (root) => {
      expect(findProjectRoot(join(root, 'docs', 'deep', 'nested'))).toBe(root);
    });
  });

  it('returns null rather than searching forever when there is no project', async () => {
    await withProject({}, (root) => {
      expect(findProjectRoot(root)).toBeNull();
    });
  });
});

describe('loadConfig', () => {
  it('loads the minimal generated configuration', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      const loaded = loadConfig({ cwd: root });
      expect(loaded.config.name).toBe('sarjbot');
      expect(loaded.projectRoot).toBe(root);
      expect(loaded.sources).toHaveLength(1);
      expect(loaded.sources[0]?.relativeRoot).toBe('docs');
      expect(loaded.sources[0]?.kind).toBe('directory');
    });
  });

  it('resolves sources relative to the config file, not the process directory', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      const fromNested = loadConfig({ cwd: join(root, 'docs') });
      expect(fromNested.sources[0]?.root).toBe(join(root, 'docs'));
      expect(fromNested.projectRoot).toBe(root);
    });
  });

  it('accepts a file source as well as a directory', async () => {
    await withProject(
      {
        'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./notes.md\n',
        'notes.md': '# Notes',
      },
      (root) => {
        expect(loadConfig({ cwd: root }).sources[0]?.kind).toBe('file');
      },
    );
  });

  it('fails with an actionable error when there is no project', async () => {
    await withProject({}, (root) => {
      try {
        loadConfig({ cwd: root });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).code).toBe('LORE_E_NOT_INITIALIZED');
        expect((error as LoreError).remediation).toContain('lorepack init');
      }
    });
  });
});

describe('validation errors', () => {
  it('reports the line and column of malformed YAML', async () => {
    await withProject({ 'lore.yaml': 'version: 1\nname: [unclosed\n' }, (root) => {
      try {
        loadConfig({ cwd: root });
        expect.unreachable('should have thrown');
      } catch (error) {
        const loreError = error as LoreError;
        expect(loreError.code).toBe('LORE_E_CONFIG_INVALID');
        expect(loreError.message).toMatch(/line \d+, column \d+/);
      }
    });
  });

  it('names the offending key and suggests the closest valid one', async () => {
    await withProject({ 'lore.yaml': `${MINIMAL}sourcs:\n  - ./typo\n` }, (root) => {
      try {
        loadConfig({ cwd: root });
        expect.unreachable('should have thrown');
      } catch (error) {
        const loreError = error as LoreError;
        expect(loreError.message).toContain('sourcs');
        expect(loreError.remediation).toContain('sources');
      }
    });
  });

  it('reports the position of a semantically invalid value', async () => {
    await withProject(
      {
        'lore.yaml': `${MINIMAL}rules:\n  - match: "**"\n    authority: 500\n`,
      },
      (root) => {
        try {
          loadConfig({ cwd: root });
          expect.unreachable('should have thrown');
        } catch (error) {
          const loreError = error as LoreError;
          expect(loreError.message).toContain('authority');
          expect(loreError.message).toMatch(/line \d+/);
        }
      },
    );
  });

  it('rejects a source that does not exist, naming it', async () => {
    await withProject({ 'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./missing\n' }, (root) => {
      try {
        loadConfig({ cwd: root });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).subject).toBe('./missing');
        expect((error as LoreError).remediation).toContain('lore.yaml');
      }
    });
  });

  it('rejects a source that escapes the project root', async () => {
    await withProject({ 'lore.yaml': 'version: 1\nname: p\nsources:\n  - ../..\n' }, (root) => {
      expect(() => loadConfig({ cwd: root })).toThrowError(LoreError);
    });
  });

  it('rejects duplicate sources', async () => {
    await withProject(
      {
        'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./docs\n  - ./docs\n',
      },
      (root) => {
        expect(() => loadConfig({ cwd: root })).toThrowError(/Duplicate source/);
      },
    );
  });

  it('rejects source roots whose normalized ids collide', async () => {
    await withProject(
      {
        'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./docs/a\n  - ./docs-a\n',
        'docs/a/.keep': '',
        'docs-a/.keep': '',
      },
      (root) => {
        try {
          loadConfig({ cwd: root });
          expect.unreachable('should have thrown');
        } catch (error) {
          const loreError = error as LoreError;
          expect(loreError.code).toBe('LORE_E_CONFIG_INVALID');
          expect(loreError.message).toContain('docs/a');
          expect(loreError.message).toContain('docs-a');
        }
      },
    );
  });

  it('rejects overlapping source roots', async () => {
    await withProject(
      {
        'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./docs\n  - ./docs/nested\n',
        'docs/nested/.keep': '',
      },
      (root) => {
        try {
          loadConfig({ cwd: root });
          expect.unreachable('should have thrown');
        } catch (error) {
          const loreError = error as LoreError;
          expect(loreError.code).toBe('LORE_E_CONFIG_INVALID');
          expect(loreError.message).toContain('docs');
          expect(loreError.message).toContain('docs/nested');
        }
      },
    );
  });
});

describe('effective configuration', () => {
  it('carries no absolute path, so it is safe as a build id input', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      const serialized = JSON.stringify(loadConfig({ cwd: root }).effective);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
      expect(serialized).not.toContain('/tmp');
    });
  });

  it('is identical for the same project loaded from two absolute roots', async () => {
    const report = await checkDeterminism({
      files: { 'lore.yaml': MINIMAL, 'docs/.keep': '' },
      produce: (project) => JSON.stringify(loadConfig({ cwd: project.root }).effective),
    });
    expect(report.message ?? '').toBe('');
  });

  it('sorts sources so declaration order cannot change identity', async () => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: p\nsources:\n  - ./b\n  - ./a\n',
          'a/.keep': '',
          'b/.keep': '',
        },
      },
      (project) => {
        expect(loadConfig({ cwd: project.root }).effective.sources).toEqual(['a', 'b']);
      },
    );
  });

  it('exposes the product defaults it resolved', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      const { effective } = loadConfig({ cwd: root });
      expect(effective.chunking).toEqual(PRODUCT_DEFAULTS.chunking);
      expect(effective.limits.maxSourceFiles).toBe(2500);
      expect(effective.followSymlinks).toBe(false);
      expect(effective.contextProfile).toBe('agent');
    });
  });

  it('lets the config override a default it owns', async () => {
    await withProject(
      {
        'lore.yaml': `${MINIMAL}strictRules: true\ncontext:\n  defaultProfile: chat\n`,
      },
      (root) => {
        const { effective } = loadConfig({ cwd: root });
        expect(effective.strictRules).toBe(true);
        expect(effective.contextProfile).toBe('chat');
      },
    );
  });

  it('is deeply frozen, so a later stage cannot mutate a build id input', async () => {
    await withProject({ 'lore.yaml': MINIMAL }, (root) => {
      const { effective } = loadConfig({ cwd: root });
      expect(Object.isFrozen(effective)).toBe(true);
      expect(Object.isFrozen(effective.limits)).toBe(true);
      expect(() => {
        (effective as { name: string }).name = 'mutated';
      }).toThrow();
    });
  });

  it('carries rules through in declaration order, which is significant', async () => {
    await withProject(
      {
        'lore.yaml': `${MINIMAL}rules:\n  - match: "archive/**"\n    status: archived\n  - match: "current/**"\n    status: active\n    authority: 100\n`,
      },
      (root) => {
        const { effective } = loadConfig({ cwd: root });
        expect(effective.rules.map((rule) => rule.match)).toEqual(['archive/**', 'current/**']);
        expect(effective.rules[1]?.authority).toBe(100);
      },
    );
  });
});

describe('portable configuration paths', () => {
  it('interprets a backslash source path POSIX-style, since lore.yaml is committed', async () => {
    await withTempProject({ files: { 'docs/sub/.keep': '' } }, (project) => {
      mkdirSync(join(project.root, 'docs', 'sub'), { recursive: true });
      writeFileSync(
        join(project.root, 'lore.yaml'),
        'version: 1\nname: p\nsources:\n  - "docs\\\\sub"\n',
        'utf8',
      );
      const loaded = loadConfig({ cwd: project.root });
      // A config written on Windows must load on Linux. Canonical form is POSIX
      // regardless of how the path was spelled.
      expect(loaded.effective.sources[0]).toBe('docs/sub');
    });
  });

  it('rejects an absolute source path, which would tie the config to one machine', async () => {
    await withTempProject({ files: { 'docs/.keep': '' } }, (project) => {
      writeFileSync(
        join(project.root, 'lore.yaml'),
        `version: 1\nname: p\nsources:\n  - ${JSON.stringify(join(project.root, 'docs'))}\n`,
        'utf8',
      );
      try {
        loadConfig({ cwd: project.root });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as LoreError).message).toContain('must be relative');
        expect((error as LoreError).remediation).toContain('committed');
      }
    });
  });
});

/**
 * Issue 583. Discovery refuses a symlink *below* a source root, but the root itself used to
 * be classified with `statSync` and contained by its path string, so a link planted as the
 * root (`docs -> ../outside`) carried the build out of the project. Containment is now
 * decided on real paths.
 */
describe('a source root behind a symbolic link', () => {
  // A directory link on Windows needs a privilege a junction does not, and Node treats a
  // junction as a symlink everywhere it matters. On POSIX the type argument is ignored.
  const DIRECTORY_LINK = platform() === 'win32' ? 'junction' : 'dir';

  /** `outside/secret.md` next to `project/`, the layout of the issue's reproduction. */
  async function withOutside<T>(sources: string, run: (root: string, outside: string) => T) {
    return withTempProject(
      { files: { 'outside/secret.md': 'TOP SECRET zebrafish' } },
      (project) => {
        const root = join(project.root, 'project');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'lore.yaml'), `version: 1\nname: p\nsources:\n${sources}`, 'utf8');
        return run(root, join(project.root, 'outside'));
      },
    );
  }

  function loadError(root: string): LoreError {
    try {
      loadConfig({ cwd: root });
    } catch (error) {
      return error as LoreError;
    }
    return expect.unreachable('the source should have been refused');
  }

  it('refuses a directory root that links outside the project', async () => {
    await withOutside('  - docs\n', (root, outside) => {
      symlinkSync(outside, join(root, 'docs'), DIRECTORY_LINK);
      const error = loadError(root);
      expect(error.code).toBe('LORE_E_PATH_ESCAPE');
      expect(error.subject).toBe('docs');
      expect(error.path).toBe('lore.yaml');
    });
  });

  it('refuses a file root that links outside the project', async () => {
    await withOutside('  - notes.md\n', (root, outside) => {
      symlinkSync(join(outside, 'secret.md'), join(root, 'notes.md'), 'file');
      const error = loadError(root);
      expect(error.code).toBe('LORE_E_PATH_ESCAPE');
      expect(error.subject).toBe('notes.md');
    });
  });

  it('refuses a root reached through a linked intermediate directory', async () => {
    await withOutside('  - a/docs\n', (root, outside) => {
      mkdirSync(join(outside, 'docs'), { recursive: true });
      symlinkSync(outside, join(root, 'a'), DIRECTORY_LINK);
      const error = loadError(root);
      expect(error.code).toBe('LORE_E_PATH_ESCAPE');
      expect(error.subject).toBe('a/docs');
    });
  });

  it('accepts a linked root that stays inside the project', async () => {
    await withOutside('  - docs\n', (root) => {
      mkdirSync(join(root, 'real'), { recursive: true });
      symlinkSync(join(root, 'real'), join(root, 'docs'), DIRECTORY_LINK);
      const loaded = loadConfig({ cwd: root });
      // Identity is the declared spelling, so retargeting an in-project link is not a
      // configuration change.
      expect(loaded.effective.sources).toEqual(['docs']);
      expect(loaded.sources[0]?.kind).toBe('directory');
    });
  });

  it('refuses two roots that are one directory under two names', async () => {
    await withOutside('  - docs\n  - real\n', (root) => {
      mkdirSync(join(root, 'real'), { recursive: true });
      symlinkSync(join(root, 'real'), join(root, 'docs'), DIRECTORY_LINK);
      expect(() => loadConfig({ cwd: root })).toThrowError(/overlap/);
    });
  });

  // mkfifo has no Windows equivalent: a named pipe there lives in its own namespace
  // (\\.\pipe\) and cannot appear inside a project directory at all.
  it.skipIf(platform() === 'win32')(
    'refuses a file root that is not a regular file, such as a FIFO',
    async () => {
      await withOutside('  - pipe.md\n', (root) => {
        execFileSync('mkfifo', [join(root, 'pipe.md')]);
        const error = loadError(root);
        expect(error.code).toBe('LORE_E_CONFIG_INVALID');
        expect(error.subject).toBe('pipe.md');
        expect(error.message).toContain('not a regular file');
      });
    },
  );
});
