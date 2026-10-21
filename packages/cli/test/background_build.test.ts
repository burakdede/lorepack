import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalStateStore, ProjectLock, stateMigrationsDirectory } from '@lorepack/backend-local';
import { causeChain, LoreError, loadConfig, ProgressBus, type ProgressEvent } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { expect, it } from 'vitest';
import { runBackgroundBuild } from '../src/services/background_build.js';
import { runBuild } from '../src/services/build.js';
import { withObserverDiagnostic } from './support/observer_diagnostic.js';

const files = {
  'lore.yaml': 'version: 1\nname: background\nsources: [docs]\n',
  'docs/a.md': '# Recovery\n\nRestore the checkpoint.\n',
};

function active(root: string) {
  const store = LocalStateStore.open(join(root, '.lore'), stateMigrationsDirectory());
  try {
    return store.current()?.buildId ?? null;
  } finally {
    store.close();
  }
}

async function released(root: string) {
  const lock = new ProjectLock(join(root, '.lore', 'lock'), { waitMs: 0 });
  await lock.withLock(async () => undefined);
  const temporary = join(root, '.lore', 'tmp');
  if (existsSync(temporary)) expect(readdirSync(temporary)).toEqual([]);
}

it('preserves build identity, progress, manifest and optional activation across the worker boundary', async () => {
  await withTempProject({ files }, async (first) => {
    const directEvents: ProgressEvent[] = [];
    const directProgress = new ProgressBus();
    directProgress.subscribe((event) => directEvents.push(event));
    const direct = await runBuild({
      config: loadConfig({ cwd: first.root }),
      progress: directProgress,
    });
    await withTempProject({ files }, async (second) => {
      const events: ProgressEvent[] = [];
      const progress = new ProgressBus();
      progress.subscribe((event) => events.push(event));
      const built = await runBackgroundBuild({
        config: loadConfig({ cwd: second.root }),
        progress,
        activate: false,
      });
      expect(built.buildId).toBe(direct.buildId);
      expect(built.counts).toEqual(direct.counts);
      expect(built.activated).toBe(false);
      expect(active(second.root)).toBeNull();
      const manifest = (root: string) =>
        JSON.parse(
          readFileSync(join(root, '.lore', 'builds', built.buildId, 'manifest.json'), 'utf8'),
        );
      expect(manifest(second.root)).toEqual(manifest(first.root));
      const stages = (received: ProgressEvent[]) =>
        received
          .filter((event) => event.type === 'stage-finished' && event.stage !== 'activating')
          .map(({ at: _at, ...event }) => event);
      expect(stages(events)).toEqual(stages(directEvents));
      await released(second.root);
      const activated = await runBackgroundBuild({
        config: loadConfig({ cwd: second.root }),
        progress,
      });
      expect(activated.buildId).toBe(built.buildId);
      expect(active(second.root)).toBe(built.buildId);
      await released(second.root);
    });
  });
});

it('preserves the LoreError class, code, exit status, remediation, path, stack and cause messages', async () => {
  await withTempProject({ files: { ...files, 'lore.lock': 'broken: [yaml' } }, async (project) => {
    const config = loadConfig({ cwd: project.root });
    const direct = await runBuild({ config, progress: new ProgressBus() }).catch(
      (error: unknown) => error,
    );
    const background = await runBackgroundBuild({ config, progress: new ProgressBus() }).catch(
      (error: unknown) => error,
    );
    expect(direct).toBeInstanceOf(LoreError);
    expect(background).toBeInstanceOf(LoreError);
    if (!(direct instanceof LoreError) || !(background instanceof LoreError))
      throw new Error('Expected build errors.');
    for (const field of [
      'code',
      'message',
      'exitCode',
      'remediation',
      'path',
      'subject',
      'details',
    ] as const) {
      expect(background[field], field).toEqual(direct[field]);
    }
    expect(background.stack).toContain('readLockfile');
    expect(background.cause).toBeInstanceOf(Error);
    expect(causeChain(background)).toEqual(causeChain(direct));
    expect(active(project.root)).toBeNull();
    await released(project.root);
  });
});

it.each(['before startup', 'during parsing'])(
  'cancels %s without activating or retaining a lock/candidate',
  async (when) => {
    await withTempProject({ files }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      project.write('docs/a.md', '# Recovery\n\nA new checkpoint.\n');
      for (let index = 0; index < 20; index += 1)
        project.write(`docs/new${index}.md`, `# New ${index}\n\nChanged input.\n`);
      const controller = new AbortController();
      const progress = new ProgressBus();
      let parsed = false;
      progress.subscribe((event) => {
        if (event.type === 'stage-started' && event.stage === 'parsing') {
          parsed = true;
          if (when === 'during parsing') controller.abort();
        }
      });
      if (when === 'before startup') controller.abort();
      const failure = await runBackgroundBuild({
        config,
        progress,
        signal: controller.signal,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LoreError);
      expect(failure).toMatchObject({ code: 'LORE_E_CANCELLED' });
      if (when === 'during parsing') expect(parsed).toBe(true);
      expect(active(project.root)).toBe(first.buildId);
      expect(readdirSync(project.path('.lore/builds'))).toEqual([first.buildId]);
      await released(project.root);
    });
  },
);

it('propagates a failed progress sink after cancelling and releasing the worker build', async () => {
  await withTempProject({ files }, async (project) => {
    const config = loadConfig({ cwd: project.root });
    const first = await runBuild({ config, progress: new ProgressBus() });
    for (let index = 0; index < 20; index += 1) {
      project.write(`docs/new${index}.md`, `# New ${index}\n\nChanged input.\n`);
    }
    const fault = new Error('The progress output sink failed.');
    const progress = new ProgressBus();
    progress.subscribe((event) => {
      if (event.type === 'stage-started' && event.stage === 'parsing') throw fault;
    });
    const failure = await withObserverDiagnostic(process.platform === 'win32', () =>
      runBackgroundBuild({ config, progress }),
    ).catch((error: unknown) => error);
    expect(failure).toBe(fault);
    expect(active(project.root)).toBe(first.buildId);
    expect(readdirSync(project.path('.lore/builds'))).toEqual([first.buildId]);
    await released(project.root);
  });
});
