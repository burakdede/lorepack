import { readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LocalStateStore, stateMigrationsDirectory } from '@lorepack/backend-local';
import { createPlan, readLockfile } from '@lorepack/compiler';
import { hashBytes, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { readBuildCatalog } from '../src/services/project.js';
import { degradedFreshness, readFreshnessObservation, readStatus } from '../src/services/status.js';
import { lockInputs } from '../src/services/versions.js';

const ORIGINAL = '# Stable\n\nThe same bytes are not the same source object.\n';
const CONFIG = 'version: 1\nname: source-reader\nsources: [docs]\n';

describe('source identity between fingerprint and parse, issue584', () => {
  it.each([
    ['warm', 'parsing'],
    ['cold', 'parsing'],
    ['warm', 'fingerprinting'],
    ['cold', 'fingerprinting'],
  ] as const)(
    'refuses an outside parent replacement with %s cache during %s and preserves the active build',
    async (cache, stage) => {
      await withTempProject({ files: { 'a.md': ORIGINAL } }, async (outside) => {
        await withTempProject(
          { files: { 'lore.yaml': CONFIG, 'docs/a.md': ORIGINAL } },
          async (temp) => {
            const config = loadConfig({ cwd: temp.root });
            const first = await runBuild({ config, progress: new ProgressBus() });
            const directory = join(temp.root, '.lore/builds', first.buildId);
            const manifest = readFileSync(join(directory, 'manifest.json'));
            const catalog = hashBytes(readFileSync(join(directory, 'context.sqlite')));
            if (cache === 'cold') {
              rmSync(join(temp.root, '.lore/cache/parse'), { recursive: true, force: true });
            }

            let replaced = false;
            const progress = new ProgressBus();
            progress.subscribe((event) => {
              if (event.type !== 'stage-started' || event.stage !== stage || replaced) return;
              replaced = true;
              renameSync(join(temp.root, 'docs'), join(temp.root, 'original-docs'));
              symlinkSync(outside.root, join(temp.root, 'docs'), 'junction');
            });

            await expect(runBuild({ config, progress })).rejects.toMatchObject({
              code: 'LORE_E_STALE_SOURCES',
            });
            expect(replaced).toBe(true);
            expect(readFileSync(join(directory, 'manifest.json'))).toEqual(manifest);
            expect(hashBytes(readFileSync(join(directory, 'context.sqlite')))).toBe(catalog);
            const state = LocalStateStore.open(
              join(temp.root, '.lore'),
              stateMigrationsDirectory(),
            );
            try {
              expect(state.current()?.buildId).toBe(first.buildId);
            } finally {
              state.close();
            }
          },
        );
      });
    },
  );
});

describe('freshness during a changed source read', () => {
  it.each(['plan', 'status', 'runtime'] as const)(
    'does not report a replaced source as certain in %s',
    async (surface) => {
      await withTempProject({ files: { 'a.md': ORIGINAL } }, async (outside) => {
        await withTempProject(
          { files: { 'lore.yaml': CONFIG, 'docs/a.md': ORIGINAL } },
          async (temp) => {
            const config = loadConfig({ cwd: temp.root });
            const first = await runBuild({ config, progress: new ProgressBus() });
            const progress = new ProgressBus();
            progress.subscribe((event) => {
              if (event.type !== 'stage-started' || event.stage !== 'fingerprinting') return;
              renameSync(join(temp.root, 'docs'), join(temp.root, 'original-docs'));
              symlinkSync(outside.root, join(temp.root, 'docs'), 'junction');
            });
            if (surface === 'runtime') {
              const freshness = await readFreshnessObservation({ config, progress });
              expect(freshness.sourceState).toBe('unknown');
              expect(freshness.inputFingerprint).toBeNull();
              expect(freshness.reason).toContain('changed');
            } else if (surface === 'status') {
              const error = await readStatus({ config, progress }).then(
                () => null,
                (cause: unknown) => cause,
              );
              expect(error).toMatchObject({ code: 'LORE_E_SOURCE_UNREADABLE' });
              expect(degradedFreshness(error)?.sourceState).toBe('unknown');
            } else {
              const { plan } = await createPlan({
                config,
                progress,
                previous: readBuildCatalog(join(temp.root, '.lore'), first.buildId),
                previousLock: readLockfile(temp.root),
                lockInputs: lockInputs(),
              });
              expect(plan.sourceState).toBe('unknown');
              expect(plan.warnings).toContainEqual(
                expect.objectContaining({ code: 'source-changed' }),
              );
            }
          },
        );
      });
    },
  );
});
