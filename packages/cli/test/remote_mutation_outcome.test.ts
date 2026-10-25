import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { createWranglerAdapter } from '../src/commands/target.js';
import { createWranglerDeployAdapter } from '../src/services/cloudflare-target.js';

it.each([
  {
    label: 'a transient fetch failure',
    firstError: 'fetch failed',
    expectedCalls: 2,
    succeeds: true,
  },
  {
    label: 'an unrelated authentication failure',
    firstError: 'authentication failed',
    expectedCalls: 1,
    succeeds: false,
  },
  {
    label: 'a persistent transient fetch failure',
    firstError: 'fetch failed',
    expectedCalls: 3,
    succeeds: false,
  },
])('retries D1 inventory after $label only', async ({ firstError, expectedCalls, succeeds }) => {
  await withTempProject({}, async (project) => {
    const directory = join(project.root, 'node_modules', 'wrangler');
    mkdirSync(join(directory, 'bin'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'wrangler',
        version: '4.149.0',
        main: './bin/wrangler.js',
        bin: './bin/wrangler.js',
      }),
    );
    const calls = join(project.root, 'calls.jsonl');
    writeFileSync(
      join(directory, 'bin', 'wrangler.js'),
      `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + String.fromCharCode(10));
const count = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split(String.fromCharCode(10)).length;
if (count === 1 || ${JSON.stringify(!succeeds)}) {
  console.error(${JSON.stringify(firstError)});
  process.exit(1);
}
console.log(JSON.stringify([{ name: 'catalog' }, { name: 'tables' }]));
`,
    );

    const inventory = createWranglerDeployAdapter(project.root).listDatabases();
    if (succeeds) {
      await expect(inventory).resolves.toEqual([{ name: 'catalog' }, { name: 'tables' }]);
    } else {
      await expect(inventory).rejects.toThrow(firstError);
    }

    const invocations = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(expectedCalls);
    expect(invocations.every((args) => args.join(' ') === 'd1 list --json')).toBe(true);
  });
});

it.each([
  'd1-write',
  'd1-returning',
  'd1-returning-7009',
  'd1-upload-access-denied',
  'd1-invalid-json',
  'r2-put',
  'r2-delete',
  'd1-read',
] as const)(
  'bounds replay of %s through the real Wrangler adapter, issue439',
  async (operation) => {
    await withTempProject({}, async (project) => {
      const directory = join(project.root, 'node_modules', 'wrangler');
      mkdirSync(join(directory, 'bin'), { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrangler',
          version: '4.0.0',
          main: './bin/wrangler.js',
          bin: './bin/wrangler.js',
        }),
      );
      const calls = join(project.root, 'calls.jsonl');
      writeFileSync(
        join(directory, 'bin', 'wrangler.js'),
        `const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
${operation === 'd1-invalid-json' ? "console.log('not JSON');" : `console.error(${JSON.stringify(operation === 'd1-returning-7009' ? 'Upstream service unavailable [code: 7009]' : operation === 'd1-upload-access-denied' ? 'File could not be uploaded. Please retry.\nGot response: <?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Denied</Message></Error>' : 'fetch failed')}); process.exit(1);`}
`,
      );
      const adapter = createWranglerDeployAdapter(project.root);
      const action =
        operation === 'd1-write' ||
        operation === 'd1-returning' ||
        operation === 'd1-returning-7009' ||
        operation === 'd1-invalid-json' ||
        operation === 'd1-read'
          ? adapter
              .openCatalogDatabase('catalog')
              .prepare(
                operation === 'd1-read'
                  ? 'SELECT ? AS answer'
                  : operation === 'd1-returning' ||
                      operation === 'd1-returning-7009' ||
                      operation === 'd1-invalid-json'
                    ? 'DELETE FROM demo WHERE id = ? RETURNING id'
                    : 'DELETE FROM demo WHERE id = ?',
              )
              .bind(1)
              .run()
          : operation === 'r2-put'
            ? adapter.openObjectsBucket('objects').put('project/objects/key', new Uint8Array([1]))
            : adapter.openObjectsBucket('objects').delete?.('project/objects/key');
      if (action === undefined) throw new Error('The real adapter must support deletion.');
      const failure = await action.catch((error: unknown) => error);
      if (operation === 'd1-read') {
        expect.soft(failure).toBeInstanceOf(Error);
        expect
          .soft(failure)
          .not.toHaveProperty('details.reason', 'remote-mutation-completion-unknown');
      } else {
        expect.soft(failure).toMatchObject({
          code: 'LORE_E_REMOTE_DEPLOY',
          details: { reason: 'remote-mutation-completion-unknown' },
        });
      }
      expect
        .soft(readFileSync(calls, 'utf8').trim().split(String.fromCharCode(10)))
        .toHaveLength(operation === 'd1-read' ? 3 : 1);
    });
  },
);

it.each(['deploy', 'target'] as const)(
  'retries a failed D1 file import through the %s adapter after Wrangler confirms imports are atomic',
  async (surface) => {
    await withTempProject({}, async (project) => {
      const directory = join(project.root, 'node_modules', 'wrangler');
      mkdirSync(join(directory, 'bin'), { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrangler',
          version: '4.149.0',
          main: './bin/wrangler.js',
          bin: './bin/wrangler.js',
        }),
      );
      const calls = join(project.root, 'calls.jsonl');
      writeFileSync(
        join(directory, 'bin', 'wrangler.js'),
        `const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + String.fromCharCode(10));
if (require('node:fs').readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split(String.fromCharCode(10)).length === 1) {
  console.error('Upstream service unavailable [code: 7009]');
  process.exit(1);
}
console.log(JSON.stringify([{ success: true, results: [] }]));
`,
      );

      const adapter =
        surface === 'deploy'
          ? createWranglerDeployAdapter(project.root)
          : createWranglerAdapter(project.root);
      const database = adapter.openCatalogDatabase('catalog');
      await database.prepare('BEGIN IMMEDIATE').run();
      await database.prepare('CREATE TABLE retry_probe (id INTEGER PRIMARY KEY)').run();
      await database.prepare('COMMIT').run();

      const invocations = readFileSync(calls, 'utf8').trim().split('\n');
      expect(invocations).toHaveLength(2);
      expect(JSON.parse(invocations[0] ?? '')).toContain('--file');
      expect(JSON.parse(invocations[1] ?? '')).toContain('--file');
    });
  },
);

it.each(['deploy', 'target'] as const)(
  'retries a rejected D1 SQL upload through the %s adapter',
  async (surface) => {
    await withTempProject({}, async (project) => {
      const directory = join(project.root, 'node_modules', 'wrangler');
      mkdirSync(join(directory, 'bin'), { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrangler',
          version: '4.149.0',
          main: './bin/wrangler.js',
          bin: './bin/wrangler.js',
        }),
      );
      const calls = join(project.root, 'calls.jsonl');
      writeFileSync(
        join(directory, 'bin', 'wrangler.js'),
        `const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + String.fromCharCode(10));
if (readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split(String.fromCharCode(10)).length === 1) {
  console.error('File could not be uploaded. Please retry.\\nGot response: <?xml version="1.0"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>');
  process.exit(1);
}
console.log(JSON.stringify([{ success: true, results: [] }]));
`,
      );

      const adapter =
        surface === 'deploy'
          ? createWranglerDeployAdapter(project.root)
          : createWranglerAdapter(project.root);
      await adapter
        .openCatalogDatabase('catalog')
        .prepare('CREATE TABLE retry_probe (id INTEGER PRIMARY KEY)')
        .run();

      const invocations = readFileSync(calls, 'utf8').trim().split('\n');
      expect(invocations).toHaveLength(2);
      expect(JSON.parse(invocations[0] ?? '')).toContain('--file');
      expect(JSON.parse(invocations[1] ?? '')).toContain('--file');
    });
  },
);

it.each(['deploy', 'target'] as const)(
  'stops after the bounded retries for a rejected D1 SQL upload through the %s adapter',
  async (surface) => {
    await withTempProject({}, async (project) => {
      const directory = join(project.root, 'node_modules', 'wrangler');
      mkdirSync(join(directory, 'bin'), { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrangler',
          version: '4.149.0',
          main: './bin/wrangler.js',
          bin: './bin/wrangler.js',
        }),
      );
      const calls = join(project.root, 'calls.jsonl');
      writeFileSync(
        join(directory, 'bin', 'wrangler.js'),
        `const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
console.error('File could not be uploaded. Please retry.\\nGot response: <?xml version="1.0"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>');
process.exit(1);
`,
      );

      const adapter =
        surface === 'deploy'
          ? createWranglerDeployAdapter(project.root)
          : createWranglerAdapter(project.root);
      const failure = await adapter
        .openCatalogDatabase('catalog')
        .prepare('CREATE TABLE retry_probe (id INTEGER PRIMARY KEY)')
        .run()
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        message: expect.stringContaining('File could not be uploaded'),
      });
      expect(failure).not.toHaveProperty('details.reason', 'remote-mutation-completion-unknown');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3);
    });
  },
);

it.each(['deploy', 'target'] as const)(
  'returns physical mutation rows through the %s Wrangler adapter, issue439',
  async (surface) => {
    await withTempProject({}, async (project) => {
      const directory = join(project.root, 'node_modules', 'wrangler');
      mkdirSync(join(directory, 'bin'), { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: 'wrangler',
          version: '4.0.0',
          main: './bin/wrangler.js',
          bin: './bin/wrangler.js',
        }),
      );
      const calls = join(project.root, 'calls.jsonl');
      const databasePath = join(project.root, 'catalog.sqlite');
      writeFileSync(
        join(directory, 'bin', 'wrangler.js'),
        `
const { appendFileSync, readFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + String.fromCharCode(10));
const db = new DatabaseSync(${JSON.stringify(databasePath)});
let results;
if (args.includes('--file')) {
  db.exec(readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
  results = [{ 'Total queries executed': 1, 'Rows written': 1 }];
} else {
  results = db.prepare(args[args.indexOf('--command') + 1]).all();
}
db.close();
console.log(JSON.stringify([{ success: true, results }]));
`,
      );
      const adapter =
        surface === 'deploy'
          ? createWranglerDeployAdapter(project.root)
          : createWranglerAdapter(project.root);
      const db = adapter.openCatalogDatabase('catalog');
      await db.prepare('BEGIN IMMEDIATE').run();
      await db
        .prepare('CREATE TABLE ownership (id INTEGER PRIMARY KEY, token TEXT NOT NULL)')
        .run();
      const acquired = await db
        .prepare('INSERT OR IGNORE INTO ownership VALUES (1, ?) RETURNING token')
        .bind('first-owner')
        .run();
      expect.soft(acquired.results).toEqual([{ token: 'first-owner' }]);
      expect
        .soft(
          (
            await db
              .prepare('INSERT OR IGNORE INTO ownership VALUES (1, ?) RETURNING token')
              .bind('second-owner')
              .run()
          ).results,
        )
        .toEqual([]);
      expect
        .soft(
          (
            await db
              .prepare('DELETE FROM ownership WHERE token = ? RETURNING token')
              .bind('first-owner')
              .run()
          ).results,
        )
        .toEqual([{ token: 'first-owner' }]);
      await db.prepare('COMMIT').run();
      const commands = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect.soft(commands.filter((args) => args.includes('--command'))).toHaveLength(3);
      expect.soft(commands.filter((args) => args.includes('--file'))).toHaveLength(1);
    });
  },
);
