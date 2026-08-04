import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildId, type LoadedConfig, loadConfig, ProgressBus } from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/services/build.js';
import { createActivateEndpoint } from '../src/services/studio-mutations.js';
import { resolveRealPath, startWatching } from '../src/services/watch.js';

/**
 * Watch mode, where the interesting cases are all the ones an editor causes.
 *
 * Architecture 24.5 says the watcher is not a source of truth, and every test here is a way
 * of proving that in practice: a save arrives as several events, a save can leave content
 * identical, an atomic rename looks like a delete followed by a create, and a file written
 * between the initial scan and the watcher becoming ready produces no event at all.
 *
 * The rebuild callback is injected rather than real in most of these. What is under test is
 * the decision to rebuild, and counting decisions is exact where timing a real build is not.
 */

const CONFIG = 'version: 1\nname: watched\nsources:\n  - .\n';
const CORPUS = { 'lore.yaml': CONFIG, 'a.md': '# A\n\nFirst document.\n' };

/**
 * Short, because these tests wait for them.
 *
 * The reconcile sweep is pushed out of the way deliberately: these tests are about what the
 * **event stream** does with editor behaviour, and a safety net that fires halfway through
 * would make "one save is one rebuild" a statement about timing. The sweep has its own test.
 */
const FAST = { debounceMs: 40, stabilityMs: 40, pollMs: 10, reconcileIntervalMs: 60_000 } as const;

async function settled(until: () => boolean | Promise<boolean>, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await until()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Activation through the route Studio actually calls.
 *
 * Reaching into the state store directly would prove the watcher notices *a* pointer move.
 * Going through the endpoint proves it notices the one a reader can cause from a browser,
 * which is the case #200 was about.
 */
async function activate(config: LoadedConfig, build: BuildId): Promise<void> {
  await createActivateEndpoint(config)({ build });
}

describe('the scan and watch race, architecture 12.11 step 3', () => {
  it('reconciles after ready, so a file written before the watcher started is not missed', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      // Written after the build and before the watcher exists, so no event will ever
      // describe it. Only the reconciliation scan can find this.
      writeFileSync(join(project.root, 'ghost.md'), '# Ghost\n\nWritten in the gap.\n', 'utf8');

      let rebuilds = 0;
      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          rebuilds += 1;
          await runBuild({ config, progress: new ProgressBus() });
          return { created: true };
        },
      });

      await watching.ready;
      await watching.close();

      expect(rebuilds, 'the reconciliation scan should have noticed the gap file').toBe(1);
    });
  }, 60_000);
});

describe('one save is one rebuild', () => {
  it('coalesces a burst of writes into a single rebuild', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let rebuilds = 0;
      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          rebuilds += 1;
          await runBuild({ config, progress: new ProgressBus() });
          return { created: true };
        },
      });
      await watching.ready;

      // What a chunked editor save looks like from outside: the same file, several times,
      // in less time than the debounce window.
      const path = join(project.root, 'a.md');
      for (let index = 0; index < 8; index += 1) {
        writeFileSync(path, `# A\n\nRevision ${index}.\n`, 'utf8');
      }

      await settled(() => rebuilds > 0);
      await watching.close();

      expect(rebuilds, 'eight writes inside the debounce window are one change').toBe(1);
    });
  }, 60_000);

  it('treats an atomic rename save as one change', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let rebuilds = 0;
      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          rebuilds += 1;
          await runBuild({ config, progress: new ProgressBus() });
          return { created: true };
        },
      });
      await watching.ready;

      // The pattern vim and many editors use: write a sibling, then rename over the target.
      const temporary = join(project.root, 'a.md.tmp');
      writeFileSync(temporary, '# A\n\nSaved atomically.\n', 'utf8');
      renameSync(temporary, join(project.root, 'a.md'));

      await settled(() => rebuilds > 0);
      await watching.close();

      expect(rebuilds).toBe(1);
    });
  }, 60_000);
});

describe('content decides, not the event', () => {
  it('does nothing when a write leaves the content identical, and says so', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let rebuilds = 0;
      const said: string[] = [];
      const watching = startWatching({
        config,
        warn: (text) => said.push(text),
        ...FAST,
        rebuild: async () => {
          rebuilds += 1;
          return { created: true };
        },
      });
      await watching.ready;

      // Rewriting the same bytes: a real event, and no change at all.
      writeFileSync(join(project.root, 'a.md'), CORPUS['a.md'], 'utf8');

      await settled(() => watching.noOps > 0);
      await watching.close();

      expect(rebuilds, 'identical content is not a rebuild').toBe(0);
      expect(watching.noOps).toBe(1);
      // Visible, not silent: a user who saved and saw nothing happen deserves the reason.
      expect(said.join('')).toContain('No changes');
    });
  }, 60_000);

  it('rebuilds when a source is deleted', async () => {
    await withTempProject(
      { files: { ...CORPUS, 'b.md': '# B\n\nSecond document.\n' } },
      async (project) => {
        const config = loadConfig({ cwd: project.root });
        await runBuild({ config, progress: new ProgressBus() });

        let rebuilds = 0;
        const watching = startWatching({
          config,
          warn: () => {},
          ...FAST,
          rebuild: async () => {
            rebuilds += 1;
            await runBuild({ config, progress: new ProgressBus() });
            return { created: true };
          },
        });
        await watching.ready;

        rmSync(join(project.root, 'b.md'));

        await settled(() => rebuilds > 0);
        await watching.close();

        expect(rebuilds).toBe(1);
      },
    );
  }, 60_000);

  it('ignores a file the project does not index', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let rebuilds = 0;
      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          rebuilds += 1;
          return { created: true };
        },
      });
      await watching.ready;

      // Excluded by the same matcher discovery uses, so it is not a source and its change
      // is not a change. Two matchers would be how these come to disagree.
      writeFileSync(join(project.root, 'notes.bin'), 'not a document', 'utf8');

      await new Promise((resolve) => setTimeout(resolve, 500));
      await watching.close();

      expect(rebuilds).toBe(0);
    });
  }, 60_000);
});

describe('what the server is told', () => {
  it('answers freshness from watcher state, without touching the filesystem', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          await runBuild({ config, progress: new ProgressBus() });
          return { created: true };
        },
      });
      await watching.ready;

      expect(await watching.freshness()).toBe('clean');

      writeFileSync(join(project.root, 'a.md'), '# A\n\nChanged for real.\n', 'utf8');
      await settled(() => watching.rebuilds > 0);

      // Rebuilt and activated, so the sources match the active build again.
      expect(await watching.freshness()).toBe('clean');
      await watching.close();
    });
  }, 60_000);

  /**
   * #200. Freshness is a claim about a *specific build*, and the pointer can move without a
   * file changing. Studio's write surface does exactly that, so the supervisor's cached
   * answer went on describing the build that was active before, and the header said "the
   * sources match this build" about a build the sources had moved past.
   */
  it('stops claiming clean when the active build changes underneath it', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });

      // A second build, so there is an older one to go back to and the two differ.
      writeFileSync(join(project.root, 'a.md'), '# A\n\nSecond revision.\n', 'utf8');
      await runBuild({ config, progress: new ProgressBus() });

      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => {
          throw new Error('the watcher must not rebuild in response to an activation');
        },
      });
      await watching.ready;
      expect(await watching.freshness()).toBe('clean');

      // Activate the older build, exactly as Studio's write surface does. No source file is
      // touched, so no filesystem event will ever describe this.
      await activate(config, first.buildId);

      // Honest immediately: the cached answer belonged to the build that just stopped being
      // active, and establishing a new one walks the corpus, which is not request-path work.
      expect(await watching.freshness()).toBe('unknown');

      // And correct shortly after, from the queued recompute. The sources carry the second
      // revision, and the build now active does not.
      await settled(async () => (await watching.freshness()) === 'dirty');
      expect(await watching.freshness()).toBe('dirty');

      // The rebuild callback above throws, so reaching here at all proves the recompute did
      // not turn a rollback into a rebuild that would have undone it.
      expect(watching.rebuilds).toBe(0);
      await watching.close();
    });
  }, 60_000);

  it('reports clean again once the pointer returns to a build the sources match', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });
      writeFileSync(join(project.root, 'a.md'), '# A\n\nSecond revision.\n', 'utf8');
      const second = await runBuild({ config, progress: new ProgressBus() });

      const watching = startWatching({
        config,
        warn: () => {},
        ...FAST,
        rebuild: async () => ({ created: false }),
      });
      await watching.ready;

      await activate(config, first.buildId);
      await settled(async () => (await watching.freshness()) === 'dirty');

      await activate(config, second.buildId);
      await settled(async () => (await watching.freshness()) === 'clean');
      expect(await watching.freshness()).toBe('clean');
      await watching.close();
    });
  }, 60_000);
});

describe('a failed rebuild', () => {
  it('keeps the previous build active and explains itself', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      const first = await runBuild({ config, progress: new ProgressBus() });

      const said: string[] = [];
      const watching = startWatching({
        config,
        warn: (text) => said.push(text),
        ...FAST,
        rebuild: async () => {
          throw new Error('the parser fell over');
        },
      });
      await watching.ready;

      writeFileSync(join(project.root, 'a.md'), '# A\n\nProvokes a failure.\n', 'utf8');
      await settled(() => said.join('').includes('Rebuild failed'));
      await watching.close();

      // Architecture 6.9: a failed rebuild is survivable, and the previous build is what
      // keeps it survivable. Exiting the supervisor would not be.
      expect(said.join('')).toContain('Rebuild failed');
      expect(said.join('')).toContain('the parser fell over');
      const { activeBuildId } = await import('../src/services/status.js').then((module) =>
        module.readStatus({ config, allowLargeProject: true }),
      );
      expect(activeBuildId).toBe(first.buildId);
    });
  }, 60_000);
});

describe('the periodic reconciliation, architecture 12.3', () => {
  /**
   * The floor under the event stream, and not a hypothetical one.
   *
   * Windows delivered no usable event for an ordinary append in CI, and a watcher whose
   * correctness depended on the stream went on serving the previous build until the test
   * timed out. On a platform where events do arrive this converges through whichever
   * mechanism is quicker, which is exactly the intended behaviour: the stream accelerates,
   * the sweep guarantees.
   */
  it('converges on a change even when nothing is waiting for an event', async () => {
    await withTempProject({ files: CORPUS }, async (project) => {
      const config = loadConfig({ cwd: project.root });
      await runBuild({ config, progress: new ProgressBus() });

      let rebuilds = 0;
      const watching = startWatching({
        config,
        warn: () => {},
        debounceMs: 40,
        stabilityMs: 40,
        pollMs: 10,
        reconcileIntervalMs: 120,
        rebuild: async () => {
          rebuilds += 1;
          await runBuild({ config, progress: new ProgressBus() });
          return { created: true };
        },
      });
      await watching.ready;

      writeFileSync(join(project.root, 'a.md'), '# A\n\nChanged, quietly.\n', 'utf8');

      await settled(() => rebuilds > 0);
      await watching.close();

      expect(rebuilds).toBeGreaterThan(0);
      // And it settles rather than rebuilding on every sweep: the signature is refreshed
      // when a settle runs, so an unchanged tree is quiet.
      const after = rebuilds;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rebuilds).toBe(after);
    });
  }, 60_000);
});

describe('the path handed to the operating system', () => {
  /**
   * Windows CI aborted the watcher outright with a libuv assertion:
   *
   *     Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
   *
   * The temporary directory was reached through an 8.3 short path
   * (`C:\Users\RUNNER~1\AppData\Local\Temp\...`), which is what `%TEMP%` gives under a
   * long user name. libuv compares the long name the OS reports against the short name it was
   * asked to watch, they do not match, and it dies. Nothing recovered, because the watcher
   * was gone rather than merely quiet.
   */
  it('is resolved, so a short path or a symlink cannot be a different string', () => {
    const resolved = resolveRealPath(tmpdir());

    expect(resolved).not.toBe('');
    // The canonical form of a path is itself canonical, which is the property libuv needs.
    expect(resolveRealPath(resolved)).toBe(resolved);
  });

  it('falls back to the path it was given rather than refusing to watch', () => {
    // A project the build has already read successfully must not become unwatchable because
    // `realpath` had an opinion about it.
    const absent = join(tmpdir(), 'lorepack-no-such-directory-8f2a1c');
    expect(resolveRealPath(absent)).toBe(absent);
  });
});
