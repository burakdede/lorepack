import { execFile } from 'node:child_process';
import { renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hashBytes, type LoadedConfig, loadConfig } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover/discover.js';
import { fingerprintSources } from '../src/fingerprint/fingerprint.js';

const execute = promisify(execFile);
const ORIGINAL = '# A\n';
const CONFIG = 'version: 1\nname: stable-source\nsources: [docs]\n';

async function inProject(
  body: (root: string, config: LoadedConfig) => Promise<void>,
): Promise<void> {
  await withTempProject({ files: { 'lore.yaml': CONFIG, 'docs/a.md': ORIGINAL } }, async (temp) =>
    body(temp.root, loadConfig({ cwd: temp.root })),
  );
}

describe('source reads after discovery, issue584', () => {
  it.each(['file', 'parent directory'] as const)(
    'excludes a %s replaced by a link before fingerprinting',
    async (kind) => {
      await withTempProject(
        { files: { 'a.md': '# Outside\n\nOutside-selection marker.\n' } },
        async (outside) =>
          inProject(async (root, config) => {
            const found = discover({ config });
            if (kind === 'file') {
              rmSync(join(root, 'docs/a.md'));
              symlinkSync(join(outside.root, 'a.md'), join(root, 'docs/a.md'));
            } else {
              renameSync(join(root, 'docs'), join(root, 'original-docs'));
              symlinkSync(outside.root, join(root, 'docs'), 'junction');
            }

            const result = await fingerprintSources({ artifacts: found.artifacts });
            expect(result.artifacts).toEqual([]);
            expect(result.totalBytes).toBe(0);
            expect(result.warnings).toEqual([
              expect.objectContaining({ code: 'source-changed', path: 'docs/a.md' }),
            ]);
          }),
      );
    },
  );

  it('refuses a replacement inode even when its content is identical', async () => {
    await inProject(async (root, config) => {
      const found = discover({ config });
      renameSync(join(root, 'docs/a.md'), join(root, 'original-a.md'));
      writeFileSync(join(root, 'docs/a.md'), ORIGINAL);

      const result = await fingerprintSources({ artifacts: found.artifacts });
      expect(result.artifacts).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'source-changed', path: 'docs/a.md' }),
      ]);
    });
  });

  it('excludes a source that grows beyond its configured cap after discovery', async () => {
    await inProject(async (root, loaded) => {
      const config = {
        ...loaded,
        effective: {
          ...loaded.effective,
          limits: { ...loaded.effective.limits, maxArtifactBytes: 100 },
        },
      };
      const found = discover({ config });
      expect(found.artifacts).toHaveLength(1);
      writeFileSync(join(root, 'docs/a.md'), 'x'.repeat(101));

      const result = await fingerprintSources({ artifacts: found.artifacts });
      expect(result.artifacts).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'artifact-too-large', path: 'docs/a.md' }),
      ]);
    });
  });

  it('reports bytes actually read when an ordinary edit stays within the cap', async () => {
    await inProject(async (root, config) => {
      const found = discover({ config });
      const current = '# Current\n\nAn ordinary edit.\n';
      writeFileSync(join(root, 'docs/a.md'), current);

      const result = await fingerprintSources({ artifacts: found.artifacts });
      expect(result.warnings).toEqual([]);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]?.contentHash).toBe(hashBytes(current));
      expect(result.artifacts[0]?.byteSize).toBe(Buffer.byteLength(current));
      expect(result.totalBytes).toBe(Buffer.byteLength(current));
    });
  });

  it('retains an unchanged ordinary file and its content hash', async () => {
    await inProject(async (_root, config) => {
      const found = discover({ config });
      const result = await fingerprintSources({ artifacts: found.artifacts });
      expect(result.warnings).toEqual([]);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]?.contentHash).toBe(hashBytes(ORIGINAL));
      expect(result.totalBytes).toBe(Buffer.byteLength(ORIGINAL));
    });
  });

  it.skipIf(process.platform === 'win32')(
    'finishes when a regular source becomes a POSIX FIFO after discovery',
    async () => {
      await inProject(async (root) => {
        const core = pathToFileURL(join(import.meta.dirname, '../../core/dist/index.js')).href;
        const compiler = pathToFileURL(join(import.meta.dirname, '../dist/index.js')).href;
        const script = `
          import { execFileSync } from 'node:child_process';
          import { rmSync } from 'node:fs';
          import { join } from 'node:path';
          import { loadConfig } from ${JSON.stringify(core)};
          import { discover, fingerprintSources } from ${JSON.stringify(compiler)};
          const root = process.argv[1];
          const found = discover({config: loadConfig({cwd: root})});
          const source = join(root, 'docs/a.md');
          rmSync(source);
          execFileSync('mkfifo', [source]);
          console.error('source-read-fixture: FIFO created after discovery');
          const result = await fingerprintSources({artifacts: found.artifacts});
          console.log(JSON.stringify(result));
        `;
        const { stdout } = await execute(
          process.execPath,
          ['--input-type=module', '-e', script, root],
          {
            timeout: 8_000,
            killSignal: 'SIGKILL',
          },
        );
        const result = JSON.parse(stdout);
        expect(result.artifacts).toEqual([]);
        expect(result.warnings).toEqual([
          expect.objectContaining({ code: 'special-file', path: 'docs/a.md' }),
        ]);
      });
    },
    15_000,
  );
});
