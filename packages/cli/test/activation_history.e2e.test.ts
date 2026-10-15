import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const BINARY = join(import.meta.dirname, '..', 'dist', 'public-entry.js');

async function cli(root: string, args: string[]) {
  const result = await execute(process.execPath, [BINARY, '--cwd', root, '--json', ...args], {
    timeout: 30_000,
  });
  return JSON.parse(result.stdout);
}

it('bare rollback follows actual activation rather than a newer never-active build', async () => {
  await withTempProject(
    {
      files: {
        'lore.yaml': 'version: 1\nname: history\nsources: [docs]\n',
        'docs/a.md': '# First\n\nFIRST_ACTIVE\n',
      },
    },
    async (temp) => {
      const first = (await cli(temp.root, ['build'])).buildId;
      writeFileSync(temp.path('docs/a.md'), '# Candidate\n\nNEVER_ACTIVE\n');
      const candidate = (await cli(temp.root, ['build', '--no-activate'])).buildId;
      writeFileSync(temp.path('docs/a.md'), '# Third\n\nTHIRD_ACTIVE\n');
      const third = (await cli(temp.root, ['build', '--no-activate'])).buildId;
      expect(new Set([first, candidate, third]).size).toBe(3);
      expect((await cli(temp.root, ['builds'])).activeBuildId).toBe(first);
      await cli(temp.root, ['activate', third]);
      const beforeRollback = await cli(temp.root, ['builds']);
      expect(beforeRollback.activeBuildId).toBe(third);
      expect(beforeRollback.rollbackBuildId).toBe(first);
      expect(beforeRollback.historyTruncated).toBe(false);
      expect(
        beforeRollback.activationHistory.map((event: { buildId: string }) => event.buildId),
      ).toEqual([third, first]);
      expect(beforeRollback.activationHistory[0]).toMatchObject({
        previousBuildId: first,
        buildId: third,
        kind: 'transition',
      });
      const displayed = await execute(process.execPath, [
        BINARY,
        '--cwd',
        temp.root,
        'builds',
        '--activations',
      ]);
      expect(displayed.stdout).toContain('Activation history (newest first):');
      expect(displayed.stdout).toContain(
        `Activated ${third.slice(0, 17)}  from ${first.slice(0, 17)}`,
      );
      expect(displayed.stdout).not.toContain(candidate.slice(0, 17));
      expect(displayed.stdout).not.toContain('ARTIFACTS');
      rmSync(temp.path('docs'), { recursive: true });
      rmSync(temp.path('.lore/cache'), { recursive: true, force: true });
      const rolledBack = await cli(temp.root, ['rollback']);
      expect(rolledBack.buildId).toBe(first);
      expect(rolledBack.buildId).not.toBe(candidate);
      expect((await cli(temp.root, ['builds'])).activeBuildId).toBe(first);
      const reversed = await cli(temp.root, ['rollback']);
      expect(reversed.buildId).toBe(third);
      expect(reversed.generation).toBeGreaterThan(rolledBack.generation);
      const beforePrune = await cli(temp.root, ['builds']);
      expect(beforePrune.activeBuildId).toBe(third);
      const pruned = await cli(temp.root, ['prune', '--keep', '1', '--yes']);
      expect(pruned.remove).toContain(first);
      expect(pruned.keep).toContain(candidate);
      await expect(
        execute(process.execPath, [BINARY, '--cwd', temp.root, '--json', 'rollback']),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('LORE_E_BUILD_NOT_FOUND'),
      });
      const afterPrune = await cli(temp.root, ['builds']);
      expect(afterPrune.activeBuildId).toBe(third);
      expect(afterPrune.rollbackBuildId).toBeNull();
      expect(afterPrune.rollbackUnavailable).toContain('no longer retained');
      expect(afterPrune.activationHistory).toEqual(beforePrune.activationHistory);
    },
  );
});
