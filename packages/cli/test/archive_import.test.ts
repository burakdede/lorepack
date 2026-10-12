import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CHECKSUM_MEMBER,
  createLocalRuntimeBackend,
  readArchive,
  writeArchive,
} from '@lorepack/backend-local';
import { loadProjectConfig } from '@lorepack/core';
import { createRuntime } from '@lorepack/runtime';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { startServing } from '../src/services/serving.js';

const execute = promisify(execFile);
const BIN = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

it('imports a verified build into an empty offline consumer without its producer, issue 419', async () => {
  await withTempProject(
    {
      files: {
        'producer/lore.yaml': 'version: 1\nname: portable\nsources:\n  - docs\n',
        'producer/docs/policy.md': '# Recovery policy\n\nRestore the checkpoint after approval.\n',
        'producer/docs/rows.csv': 'id,enabled,label\n1,true,Alpha\n2,false,Beta\n',
      },
    },
    async (project) => {
      const producer = join(project.root, 'producer');
      const consumer = join(project.root, 'consumer');
      const archive = join(project.root, 'portable.lorepack');
      const cli = async (cwd: string, args: string[]) =>
        JSON.parse(
          (
            await execute(process.execPath, [BIN, '--cwd', cwd, '--json', ...args], {
              timeout: 120_000,
            })
          ).stdout,
        );
      const built = await cli(producer, ['build']);
      await cli(producer, ['pack', '--out', archive]);
      expect(await cli(producer, ['pack', '--verify', archive])).toMatchObject({
        ok: true,
        buildId: built.buildId,
      });
      rmSync(producer, { recursive: true });
      mkdirSync(consumer);
      expect(await cli(consumer, ['import', archive])).toMatchObject({
        buildId: built.buildId,
        activated: false,
      });
      expect(await cli(consumer, ['builds'])).toMatchObject({ activeBuildId: null });
      await cli(consumer, ['activate', built.buildId]);
      expect(await cli(consumer, ['search', 'checkpoint'])).toMatchObject({
        buildId: built.buildId,
      });
      const backend = createLocalRuntimeBackend({ projectRoot: consumer });
      try {
        const runtime = createRuntime(backend);
        expect((await runtime.describeBuild()).buildId).toBe(built.buildId);
        const source = await runtime.readSource({ path: 'policy.md' });
        expect(source.buildId).toBe(built.buildId);
        expect(source.text).toContain('after approval');
        const tables = await runtime.listTables();
        expect(tables).toHaveLength(1);
        const table = await runtime.describeTable(tables[0]?.tableId ?? '');
        const rows = await runtime.queryTable({
          tableId: table.tableId,
          sql: `SELECT ${table.columns.map((column) => column.sqlName).join(', ')} FROM ${table.sqlName}`,
        });
        expect(rows.buildId).toBe(built.buildId);
        expect(rows.rows).toEqual([
          { id: 1, enabled: true, label: 'Alpha' },
          { id: 2, enabled: false, label: 'Beta' },
        ]);
      } finally {
        backend.close();
      }
      const server = await startServing({
        config: loadProjectConfig({ cwd: consumer }),
        host: '127.0.0.1',
        port: 47_991,
        warn: () => {},
      });
      try {
        const response = await fetch(`${server.url}/v1/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'checkpoint' }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          buildId: built.buildId,
          sourceState: 'unknown',
        });
        const metadata = await fetch(`${server.url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'lore_build_info', arguments: {} },
          }),
        });
        expect(metadata.status).toBe(200);
        expect(await metadata.text()).toContain(built.buildId);
      } finally {
        await server.close();
      }
      await expect(cli(consumer, ['import', archive])).rejects.toMatchObject({
        stdout: expect.stringContaining('already exists'),
      });
      expect(await cli(consumer, ['builds'])).toMatchObject({ activeBuildId: built.buildId });
    },
  );
}, 180_000);

it.each(['missing-object', 'logical-tamper', 'unsupported-member', 'store-link'])(
  'refuses %s without changing the consumer active build, issue 419',
  async (alteration) => {
    await withTempProject(
      {
        files: {
          'producer/lore.yaml': 'version: 1\nname: portable\nsources:\n  - docs\n',
          'producer/docs/policy.md': '# Original\n\nOriginal checkpoint policy.\n',
          'consumer/lore.yaml': 'version: 1\nname: existing\nsources:\n  - docs\n',
          'consumer/docs/policy.md': '# Replacement\n\nReplacement checkpoint policy.\n',
        },
      },
      async (project) => {
        const producer = join(project.root, 'producer');
        const consumer = join(project.root, 'consumer');
        const archive = join(project.root, 'original.lorepack');
        const cli = (cwd: string, args: string[]) =>
          execute(process.execPath, [BIN, '--cwd', cwd, '--json', ...args], {
            timeout: 120_000,
          });
        await cli(producer, ['build']);
        await cli(producer, ['pack', '--out', archive]);
        const second = JSON.parse((await cli(consumer, ['build'])).stdout).buildId;
        const members = await readArchive(archive);
        members.delete(CHECKSUM_MEMBER);
        if (alteration === 'missing-object') {
          const object = [...members.keys()].find((name) => name.startsWith('objects/sha256/'));
          expect(object).toBeDefined();
          members.delete(object ?? '');
        } else if (alteration === 'logical-tamper') {
          const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json')));
          manifest.counts.chunks += 1;
          members.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
        } else if (alteration === 'unsupported-member')
          members.set('payload/private.bin', new TextEncoder().encode('unexpected payload'));
        const invalid = join(project.root, 'invalid.lorepack');
        await writeArchive(
          invalid,
          [...members].map(([path, bytes]) => ({ path, bytes })),
        );
        rmSync(producer, { recursive: true });
        rmSync(join(consumer, 'docs'), { recursive: true });
        const outside = join(project.root, 'outside-objects');
        let outsideBefore: string[] = [];
        if (alteration === 'store-link') {
          renameSync(join(consumer, '.lore/objects'), outside);
          symlinkSync(
            outside,
            join(consumer, '.lore/objects'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          outsideBefore = readdirSync(outside, { recursive: true }) as string[];
        }
        await expect(cli(consumer, ['import', invalid])).rejects.toMatchObject({
          stdout: expect.stringContaining('LORE_E_'),
        });
        expect(JSON.parse((await cli(consumer, ['builds'])).stdout)).toMatchObject({
          activeBuildId: second,
          builds: [{ buildId: second }],
        });
        expect(JSON.parse((await cli(consumer, ['search', 'replacement'])).stdout)).toMatchObject({
          buildId: second,
        });
        if (alteration === 'store-link')
          expect(readdirSync(outside, { recursive: true })).toEqual(outsideBefore);
      },
    );
  },
  180_000,
);
