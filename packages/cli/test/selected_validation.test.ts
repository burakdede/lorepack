import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { readActiveBuild } from '../src/services/project.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        entries[relative(root, path).split(sep).join('/')] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      else throw new Error('The fixture must contain ordinary files and directories.');
    }
  };
  walk(root);
  return entries;
}

it.each(['changed', 'removed'] as const)(
  'verifies captured sealed A with %s sources without mutating the project, issue415',
  async (sourceState) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: sealed\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nThe sealed approval rule is A.\n',
          'docs/invoices.csv': 'invoice_id,net_cents\n00017,120000\n',
        },
      },
      async (project) => {
        const built = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'build',
        ]);
        const a = (JSON.parse(built.stdout) as { buildId: string }).buildId;
        if (sourceState === 'changed')
          writeFileSync(
            join(project.root, 'docs/policy.md'),
            '# Policy\n\nThe uncompiled approval rule is B.\n',
          );
        else rmSync(join(project.root, 'docs'), { recursive: true });
        const before = snapshot(project.root);
        const active = readActiveBuild(join(project.root, '.lore'));
        const result = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'validate',
          '--build',
          a,
        ])
          .then((result) => ({ ...result, code: 0 }))
          .catch((error: { stdout: string; stderr: string; code: number }) => error);
        expect.soft(result.code, result.stderr).toBe(0);
        if (result.code === 0) {
          expect(JSON.parse(result.stdout)).toMatchObject({
            buildId: a,
            mode: 'existing-build',
            ok: true,
          });
        }
        const human = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          'validate',
          '--build',
          a,
        ]);
        expect(human.stdout).toContain(`Verified retained build ${a}.`);
        expect(human.stdout).toContain(
          'Sources, stored build data and the active pointer were not changed.',
        );
        expect(human.stderr).not.toContain('Discovering');
        expect(result.stderr).not.toContain('Discovering');
        expect(result.stderr).not.toContain('Parsing');
        expect(readActiveBuild(join(project.root, '.lore'))).toEqual(active);
        expect(snapshot(project.root)).toEqual(before);
      },
    );
  },
);

it('refuses a large corrupted normalized object without materializing its body, issue415', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: sealed\nsources: [docs]\n',
        'docs/policy.md': '# Policy\n\nRetained memory proof.\n',
      },
    },
    async (project) => {
      const built = await execute(process.execPath, [
        BIN,
        '--cwd',
        project.root,
        '--json',
        'build',
      ]);
      const { buildId } = JSON.parse(built.stdout) as { buildId: string };
      const db = new DatabaseSync(
        join(project.root, '.lore', 'builds', buildId, 'context.sqlite'),
        { readOnly: true },
      );
      const hash = String(db.prepare('SELECT object_hash FROM artifacts').get()?.object_hash);
      db.close();
      const fd = openSync(
        join(
          project.root,
          '.lore',
          'objects',
          'sha256',
          hash.slice(0, 2),
          hash.slice(2, 4),
          hash.slice(4),
        ),
        'w',
      );
      try {
        const block = Buffer.alloc(1024 * 1024, 65);
        for (let index = 0; index < 128; index++) writeSync(fd, block);
      } finally {
        closeSync(fd);
      }
      const core = pathToFileURL(join(import.meta.dirname, '../../core/dist/index.js')).href;
      const service = pathToFileURL(
        join(import.meta.dirname, '../dist/services/validate_existing.js'),
      ).href;
      const code = `
import { loadProjectConfig } from ${JSON.stringify(core)};
import { validateExistingBuild } from ${JSON.stringify(service)};
const before = process.memoryUsage().rss;
let code;
try { await validateExistingBuild(loadProjectConfig({cwd:${JSON.stringify(project.root)}}), ${JSON.stringify(buildId)}); }
catch(error) { code = error.code; }
console.log(JSON.stringify({code, rssDelta:process.memoryUsage().rss-before}));
`;
      const result = await execute(process.execPath, ['--input-type=module', '--eval', code]);
      const measured = JSON.parse(result.stdout) as { code: string; rssDelta: number };
      expect(measured.code).toBe('LORE_E_OBJECT_CORRUPT');
      expect(measured.rssDelta).toBeLessThan(128 * 1024 * 1024);
    },
  );
});

it.each(['node-line', 'chunk-line', 'table-line'] as const)(
  'refuses a real retained %s corruption without changing active B, issue415',
  async (corruption) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: sealed\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nRecorded A.\n',
          'docs/data.csv': 'id,value\n00017,120000\n',
        },
      },
      async (project) => {
        const build = async () =>
          JSON.parse(
            (await execute(process.execPath, [BIN, '--cwd', project.root, '--json', 'build']))
              .stdout,
          ) as { buildId: string };
        const a = await build();
        writeFileSync(join(project.root, 'docs/policy.md'), '# Policy\n\nRecorded B.\n');
        await build();
        const db = new DatabaseSync(
          join(project.root, '.lore', 'builds', a.buildId, 'context.sqlite'),
        );
        try {
          if (corruption === 'node-line')
            db.exec("UPDATE nodes SET line_end=100000 WHERE kind='paragraph'");
          if (corruption === 'chunk-line')
            db.exec("UPDATE chunks SET line_end=100000 WHERE relative_path='policy.md'");
          if (corruption === 'table-line') db.exec('UPDATE tables SET line_end=100000');
        } finally {
          db.close();
        }
        const active = readActiveBuild(join(project.root, '.lore'));
        const before = snapshot(project.root);
        const result = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'validate',
          '--build',
          a.buildId,
        ])
          .then((result) => ({ ...result, code: 0 }))
          .catch((error: { stdout: string; stderr: string; code: number }) => error);
        expect(result.code, result.stdout).not.toBe(0);
        expect(result.stdout).toContain('LORE_E_OBJECT_CORRUPT');
        expect(result.stdout).toContain('locator-ranges');
        expect(readActiveBuild(join(project.root, '.lore'))).toEqual(active);
        expect(snapshot(project.root)).toEqual(before);
      },
    );
  },
);

it.each([
  { args: ['--build', 'lore_123'], code: 'LORE_E_BUILD_NOT_FOUND' },
  { args: ['--build', `lore_${'a'.repeat(64)}`], code: 'LORE_E_BUILD_NOT_FOUND' },
  { args: ['--build', `lore_${'a'.repeat(64)}`, '--frozen'], code: 'LORE_E_INVALID_ARGUMENT' },
  {
    args: ['--build', `lore_${'a'.repeat(64)}`, '--allow-large-project'],
    code: 'LORE_E_INVALID_ARGUMENT',
  },
])(
  'refuses an unsupported selection without initializing build storage: $args',
  async ({ args, code }) => {
    await withTempProject(
      { files: { 'lore.yaml': 'version: 1\nname: sealed\nsources: [missing]\n' } },
      async (project) => {
        const before = snapshot(project.root);
        const result = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'validate',
          ...args,
        ])
          .then((result) => ({ ...result, code: 0 }))
          .catch((error: { stdout: string; stderr: string; code: number }) => error);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toContain(code);
        expect(snapshot(project.root)).toEqual(before);
      },
    );
  },
);

it.each(['identity-inputs', 'object', 'table-count'] as const)(
  'refuses retained %s damage without repair, issue415',
  async (damage) => {
    await withTempProject(
      {
        files: {
          'lore.yaml': 'version: 1\nname: sealed\nsources: [docs]\n',
          'docs/policy.md': '# Policy\n\nSealed context.\n',
          'docs/data.csv': 'id,value\n00017,120000\n',
        },
      },
      async (project) => {
        const built = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'build',
        ]);
        const { buildId } = JSON.parse(built.stdout) as { buildId: string };
        const directory = join(project.root, '.lore', 'builds', buildId);
        const db = new DatabaseSync(join(directory, 'context.sqlite'));
        try {
          if (damage === 'table-count') db.exec('UPDATE tables SET row_count=99');
          if (damage === 'object') {
            const hash = String(
              db.prepare('SELECT object_hash FROM artifacts LIMIT 1').get()?.object_hash,
            );
            rmSync(
              join(
                project.root,
                '.lore',
                'objects',
                'sha256',
                hash.slice(0, 2),
                hash.slice(2, 4),
                hash.slice(4),
              ),
            );
          }
          if (damage === 'identity-inputs')
            rmSync(join(directory, 'reports', 'build-id-inputs.json'));
        } finally {
          db.close();
        }
        const before = snapshot(project.root);
        const active = readActiveBuild(join(project.root, '.lore'));
        const result = await execute(process.execPath, [
          BIN,
          '--cwd',
          project.root,
          '--json',
          'validate',
          '--build',
          buildId,
        ])
          .then((result) => ({ ...result, code: 0 }))
          .catch((error: { stdout: string; stderr: string; code: number }) => error);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toContain(
          damage === 'identity-inputs' ? 'LORE_E_SCHEMA_MISMATCH' : 'LORE_E_OBJECT_CORRUPT',
        );
        expect(readActiveBuild(join(project.root, '.lore'))).toEqual(active);
        expect(snapshot(project.root)).toEqual(before);
      },
    );
  },
);
