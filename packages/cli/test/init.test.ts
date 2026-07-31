import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME, IGNORE_FILENAME, loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { projectNameFrom, renderConfig } from '../src/services/init.js';
import { run } from './helpers.js';

const GITIGNORE = '.gitignore';

/** Runs the real command against a temp directory, the way a user would. */
async function init(root: string, args: readonly string[] = []) {
  return run(['--cwd', root, 'init', ...args]);
}

describe('first run', () => {
  it('creates the three project files and reports each one', async () => {
    await withTempProject({ files: { 'docs/a.md': '# A' } }, async (project) => {
      const result = await init(project.root);
      expect(result.code).toBe(0);

      for (const file of [CONFIG_FILENAME, IGNORE_FILENAME, GITIGNORE]) {
        expect(existsSync(join(project.root, file)), file).toBe(true);
        expect(result.stdout).toContain(file);
      }
    });
  });

  it('writes a configuration that loads and validates', async () => {
    await withTempProject({ files: { 'docs/a.md': '# A' } }, async (project) => {
      await init(project.root);
      const loaded = loadConfig({ cwd: project.root });
      expect(loaded.config.version).toBe(1);
      expect(loaded.config.sources).toEqual(['.']);
      expect(loaded.effective.name).toBe(loaded.config.name);
    });
  });

  it('names the project after its directory', async () => {
    await withTempProject({ files: { 'sarjbot/docs/a.md': '# A' } }, async (project) => {
      const target = join(project.root, 'sarjbot');
      await init(target);
      expect(loadConfig({ cwd: target }).config.name).toBe('sarjbot');
    });
  });

  it('adds .lore/ to .gitignore, creating the file when absent', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      expect(readFileSync(join(project.root, GITIGNORE), 'utf8')).toContain('.lore/');
    });
  });

  it('points at the next command', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      const result = await init(project.root);
      expect(result.stdout).toContain('lore build');
    });
  });
});

describe('idempotence', () => {
  it('changes nothing on a second run and says so', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      const before = readFileSync(join(project.root, CONFIG_FILENAME), 'utf8');

      const second = await init(project.root);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Already initialized');
      expect(readFileSync(join(project.root, CONFIG_FILENAME), 'utf8')).toBe(before);
    });
  });

  it('preserves a hand-edited project name across a re-run', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      writeFileSync(
        join(project.root, CONFIG_FILENAME),
        renderConfig('renamed-by-hand', ['.']),
        'utf8',
      );
      await init(project.root);
      expect(loadConfig({ cwd: project.root }).config.name).toBe('renamed-by-hand');
    });
  });

  it('overwrites only with --force, and shows what would change first', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      writeFileSync(join(project.root, CONFIG_FILENAME), renderConfig('custom', ['.']), 'utf8');

      const preview = await init(project.root);
      expect(preview.stdout).toContain('--force');
      expect(loadConfig({ cwd: project.root }).config.name).toBe('custom');

      await init(project.root, ['--force']);
      expect(loadConfig({ cwd: project.root }).config.name).toBe(projectNameFrom(project.root));
    });
  });

  it('does not add a duplicate .gitignore entry', async () => {
    await withTempProject(
      { files: { 'a.md': '#', '.gitignore': 'node_modules/\n.lore/\n' } },
      async (project) => {
        await init(project.root);
        const contents = readFileSync(join(project.root, GITIGNORE), 'utf8');
        expect(contents.split('\n').filter((line) => line.trim() === '.lore/')).toHaveLength(1);
      },
    );
  });

  it('appends to an existing .gitignore without disturbing it', async () => {
    await withTempProject(
      { files: { 'a.md': '#', '.gitignore': 'node_modules/\ndist/\n' } },
      async (project) => {
        await init(project.root);
        const contents = readFileSync(join(project.root, GITIGNORE), 'utf8');
        expect(contents).toContain('node_modules/');
        expect(contents).toContain('dist/');
        expect(contents).toContain('.lore/');
      },
    );
  });

  it('preserves CRLF line endings in an existing .gitignore', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      writeFileSync(join(project.root, GITIGNORE), 'node_modules/\r\ndist/\r\n', 'utf8');
      await init(project.root);
      const contents = readFileSync(join(project.root, GITIGNORE), 'utf8');
      expect(contents).toContain('\r\n');
      expect(contents).not.toMatch(/[^\r]\n\.lore\//);
    });
  });
});

describe('--dry-run', () => {
  it('reports what would change and writes nothing', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      const before = readdirSync(project.root).sort();
      const result = await init(project.root, ['--dry-run']);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Would create');
      expect(result.stdout).toContain(CONFIG_FILENAME);
      expect(readdirSync(project.root).sort()).toEqual(before);
    });
  });
});

describe('secret-shaped files', () => {
  it('warns about credential-looking filenames without reading them', async () => {
    await withTempProject(
      {
        files: {
          'a.md': '#',
          '.env': 'SECRET=should-never-be-read',
          'keys/server.pem': 'PRIVATE KEY',
          'nested/id_rsa': 'KEY',
        },
      },
      async (project) => {
        const result = await init(project.root);
        expect(result.stdout).toContain('look like credentials');
        expect(result.stdout).toContain('.env');
        expect(result.stdout).toContain('keys/server.pem');
        expect(result.stdout).toContain('nested/id_rsa');
        // The guardrail is about names. Contents must never be echoed.
        expect(result.stdout).not.toContain('should-never-be-read');
        expect(result.stdout).toContain('not a secret scanner');
      },
    );
  });

  it('says nothing when there is nothing to warn about', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      const result = await init(project.root);
      expect(result.stdout).not.toContain('look like credentials');
    });
  });
});

describe('failure modes', () => {
  it('refuses a path that does not exist', async () => {
    await withTempProject({}, async (project) => {
      const result = await run(['--cwd', project.root, 'init', 'no-such-directory']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });
  });

  it('refuses a path that is a file', async () => {
    await withTempProject({ files: { 'notes.md': '#' } }, async (project) => {
      const result = await run(['--cwd', project.root, 'init', 'notes.md']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a directory');
    });
  });

  it('refuses to nest a project inside an existing one', async () => {
    await withTempProject({ files: { 'docs/a.md': '#' } }, async (project) => {
      await init(project.root);
      const result = await run(['--cwd', project.root, 'init', 'docs']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already inside a Lorepack project');
      expect(existsSync(join(project.root, 'docs', CONFIG_FILENAME))).toBe(false);
    });
  });

  it('leaves nothing behind when the directory is not writable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // Windows permissions and root both defeat chmod, so the failure cannot be staged.
      return;
    }
    await withTempProject({ files: { 'locked/a.md': '#' } }, async (project) => {
      const target = join(project.root, 'locked');
      chmodSync(target, 0o500);
      try {
        const result = await run(['--cwd', project.root, 'init', 'locked']);
        expect(result.code).not.toBe(0);
        expect(readdirSync(target).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
        expect(existsSync(join(target, CONFIG_FILENAME))).toBe(false);
      } finally {
        chmodSync(target, 0o700);
      }
    });
  });
});

describe('--json', () => {
  it('emits a machine-readable result on stdout', async () => {
    await withTempProject({ files: { 'a.md': '#', '.env': 'X=1' } }, async (project) => {
      const result = await run(['--cwd', project.root, '--json', 'init']);
      const parsed = JSON.parse(result.stdout) as {
        creates: string[];
        written: string[];
        secretShaped: string[];
        projectName: string;
      };
      expect(parsed.creates).toContain(CONFIG_FILENAME);
      expect(parsed.written).toContain(CONFIG_FILENAME);
      expect(parsed.secretShaped).toEqual(['.env']);
      expect(parsed.projectName).toBe(projectNameFrom(project.root));
    });
  });
});

describe('generated content', () => {
  it('produces the minimal documented configuration, nothing more', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      const contents = readFileSync(join(project.root, CONFIG_FILENAME), 'utf8');
      expect(contents).toMatch(/^version: 1$/m);
      expect(contents).toMatch(/^sources:$/m);
      // Rules and context are opt-in; a generated file must not pre-fill them.
      expect(contents).not.toContain('rules:');
      expect(contents).not.toContain('context:');
    });
  });

  it('seeds .loreignore with the default exclusions and a comment explaining them', async () => {
    await withTempProject({ files: { 'a.md': '#' } }, async (project) => {
      await init(project.root);
      const contents = readFileSync(join(project.root, IGNORE_FILENAME), 'utf8');
      expect(contents).toContain('node_modules/**');
      expect(contents).toContain('.env');
      expect(contents.startsWith('#')).toBe(true);
    });
  });
});

describe('projectNameFrom', () => {
  it.each([
    ['/home/someone/sarjbot', 'sarjbot'],
    ['/home/someone/my project', 'my project'],
    ['/home/someone/weird!!name', 'weird-name'],
    ['C:\\Users\\someone\\docs', 'docs'],
  ])('%s becomes %s', (directory, expected) => {
    expect(projectNameFrom(directory)).toBe(expected);
  });

  it('falls back rather than producing an empty name', () => {
    expect(projectNameFrom('/')).toBe('project');
    expect(projectNameFrom('///')).toBe('project');
  });

  it('produces a name the config schema accepts', async () => {
    await withTempProject({ files: { '!!weird!!/a.md': '#' } }, async (project) => {
      const target = join(project.root, '!!weird!!');
      mkdirSync(target, { recursive: true });
      await init(target);
      expect(() => loadConfig({ cwd: target })).not.toThrow();
    });
  });
});
