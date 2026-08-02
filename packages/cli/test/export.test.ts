import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextBundleSchema } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { run } from './helpers.js';

/**
 * `lore export`, the bridge for every chat product that cannot speak MCP.
 *
 * What matters is that the file is honest: bounded, cited, explicit about what did not
 * fit, and free of anything Lorepack wrote about the content.
 */

const CONFIG = 'version: 1\nname: exported\nsources:\n  - .\n';

const CORPUS = {
  'lore.yaml': CONFIG,
  'guides/rollback.md':
    '# Rollback\n\n## Procedure\n\nTo roll back a release, activate the previous build. Rollback never recompiles.\n',
  'guides/deployment.md':
    '# Deployment\n\n## Release\n\nA release goes out on Tuesday unless a change freeze is in effect.\n',
};

async function exported<T>(
  args: readonly string[],
  body: (result: Awaited<ReturnType<typeof run>>, root: string) => T,
): Promise<T> {
  return withTempProject({ files: CORPUS }, async (project) => {
    await run(['--cwd', project.root, 'build']);
    const result = await run(['--cwd', project.root, ...args]);
    return body(result, project.root);
  });
}

describe('the markdown a person pastes', () => {
  it('includes every element architecture 14.6 lists', async () => {
    await exported(['export', '--task', 'how do I roll back a release'], (result) => {
      expect(result.code).toBe(0);
      const text = result.stdout;

      expect(text).toContain('# Context for: how do I roll back a release');
      expect(text).toMatch(/build `lore_[0-9a-f]{64}`/);
      expect(text).toContain('Profile **chat**');
      expect(text).toContain('estimated tokens');
      expect(text).toContain('## Context');
      expect(text).toContain('### guides/rollback.md');
      expect(text).toContain('## Citations');
      expect(text).toContain('## What was left out');
      expect(text).toContain('## Getting more');
      expect(text).toContain('lore export --task');
    });
  });

  it('says the tokens are an estimate, wherever they appear', async () => {
    await exported(['export', '--task', 'rollback'], (result) => {
      expect(result.stdout).toContain('estimated token');
      expect(result.stdout).toMatch(/conservative estimates/);
    });
  });

  it('claims nothing about which document is right', async () => {
    await exported(['export', '--task', 'rollback'], (result) => {
      expect(result.stdout).toMatch(/no claim about which document is correct/);
      expect(result.stdout).not.toMatch(/detected conflict|contradicts/i);
    });
  });

  it('defaults to the chat profile and its budget', async () => {
    await exported(['export', '--task', 'rollback'], (result) => {
      expect(result.stdout).toContain('budget 24,000 estimated tokens');
    });
  });

  it('honours an explicit profile and budget', async () => {
    await exported(['export', '--task', 'rollback', '--profile', 'deep'], (result) => {
      expect(result.stdout).toContain('Profile **deep**');
      expect(result.stdout).toContain('40,000');
    });
    await exported(['export', '--task', 'rollback', '--budget', '3000'], (result) => {
      expect(result.stdout).toContain('budget 3,000 estimated tokens');
    });
  });
});

describe('json', () => {
  it('is the serialized bundle, and validates against the committed schema', async () => {
    await exported(['export', '--task', 'rollback', '--format', 'json'], (result) => {
      const parsed = JSON.parse(result.stdout);
      expect(() => contextBundleSchema.parse(parsed)).not.toThrow();
    });
  });
});

describe('writing a file', () => {
  it('writes it, and reports what it contains on stderr', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await run(['--cwd', project.root, 'build']);
      const out = join(project.root, 'context.md');
      const result = await run([
        '--cwd',
        project.root,
        'export',
        '--task',
        'rollback',
        '--output',
        out,
      ]);

      expect(result.code).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf8')).toContain('# Context for: rollback');
      expect(result.stderr).toContain('citations');
      // stdout stays empty, so `--output` and a redirect do not both write the file.
      expect(result.stdout.trim()).toBe('');
    });
  });

  it('refuses to overwrite without --force, and overwrites with it', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await run(['--cwd', project.root, 'build']);
      const out = join(project.root, 'context.md');
      writeFileSync(out, 'something a person wrote', 'utf8');

      const refused = await run([
        '--cwd',
        project.root,
        'export',
        '--task',
        'rollback',
        '--output',
        out,
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('--force');
      expect(readFileSync(out, 'utf8')).toBe('something a person wrote');

      const forced = await run([
        '--cwd',
        project.root,
        'export',
        '--task',
        'rollback',
        '--output',
        out,
        '--force',
      ]);
      expect(forced.code).toBe(0);
      expect(readFileSync(out, 'utf8')).toContain('# Context for');
    });
  });

  it('produces the same bytes through --output as through a redirect', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await run(['--cwd', project.root, 'build']);
      // Written outside the project on purpose. An export dropped inside it is a new
      // document, so the project becomes dirty and the next export carries a freshness
      // warning the first one did not: a real difference, not a rendering one.
      const out = join(mkdtempSync(join(tmpdir(), 'lore-export-')), 'context.md');
      await run(['--cwd', project.root, 'export', '--task', 'rollback', '--output', out]);
      const piped = await run(['--cwd', project.root, 'export', '--task', 'rollback']);

      expect(readFileSync(out, 'utf8').trim()).toBe(piped.stdout.trim());
    });
  });

  it('makes the project dirty when the export lands inside it, which is not a defect', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await run(['--cwd', project.root, 'build']);
      const inside = join(project.root, 'context.md');
      await run(['--cwd', project.root, 'export', '--task', 'rollback', '--output', inside]);

      // Unlike a `.lorepack` archive (#148), an exported document is a document: a user may
      // well want it indexed. So the next export says the sources moved, and is right.
      const next = await run(['--cwd', project.root, 'export', '--task', 'rollback']);
      expect(next.stdout).toContain('sources have changed');
    });
  });
});

describe('refusals', () => {
  it('needs a task', async () => {
    await exported(['export'], (result) => {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--task');
    });
  });

  it('names the valid formats and profiles', async () => {
    await exported(['export', '--task', 'a', '--format', 'yaml'], (result) => {
      expect(result.stderr).toContain('markdown or json');
    });
    await exported(['export', '--task', 'a', '--profile', 'enormous'], (result) => {
      expect(result.stderr).toContain('agent, coding, chat, deep');
    });
  });

  it('refuses a project with no build, actionably', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const result = await run(['--cwd', project.root, 'export', '--task', 'rollback']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lore build');
    });
  });
});

describe('freshness', () => {
  it('warns in the file itself when the sources have moved on', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      await run(['--cwd', project.root, 'build']);
      writeFileSync(join(project.root, 'new.md'), '# New\n\nNot in the build.\n', 'utf8');

      const result = await run(['--cwd', project.root, 'export', '--task', 'rollback']);
      expect(result.stdout).toContain('sources have changed');
      expect(result.stdout).toContain('lore build');
    });
  });
});
