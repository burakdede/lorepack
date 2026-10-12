import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { createWranglerDeployAdapter } from '../src/services/cloudflare-target.js';

it.each(['d1-write', 'r2-put', 'r2-delete', 'd1-read'] as const)(
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
console.error('fetch failed'); process.exit(1);
`,
      );
      const adapter = createWranglerDeployAdapter(project.root);
      const action =
        operation === 'd1-write' || operation === 'd1-read'
          ? adapter
              .openCatalogDatabase('catalog')
              .prepare(
                operation === 'd1-read' ? 'SELECT ? AS answer' : 'DELETE FROM demo WHERE id = ?',
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
