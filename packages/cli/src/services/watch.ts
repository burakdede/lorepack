import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createSourceMatcher, discover } from '@lorepack/compiler';
import type { LoadedConfig, SourceState } from '@lorepack/core';
import { watch as chokidarWatch } from 'chokidar';
import { readFreshness } from './status.js';

/**
 * Watching the sources, where the watcher is an accelerator and never the truth.
 *
 * Architecture 24.5 is blunt about this and 12.11 encodes it as an algorithm: filesystem
 * events are a hint that something *may* have changed, and content hashes decide whether
 * anything did. Every step below exists because some real editor or filesystem breaks the
 * naive version:
 *
 * 1. the initial scan is the build the supervisor already ran;
 * 2. start the watcher;
 * 3. **reconcile after `ready`**, because a file written between the scan and the watcher
 *    becoming ready belongs to neither and would be missed forever;
 * 4. coalesce events over a debounce window, since one save is many events;
 * 5. wait for size and modification time to stop moving, because editors write in chunks
 *    and a hash taken mid-write is a hash of half a file;
 * 6. fingerprint the content;
 * 7. do nothing when the content is unchanged, which is what a touch or an atomic rename
 *    of identical bytes produces;
 * 8. build a candidate;
 * 9. activate only after validation, which `runBuild` already guarantees.
 *
 * The watcher also answers `freshness()` for the server, which is the hook #112 named: a
 * supervisor that is already watching knows whether the sources moved, so the server it
 * supervises should stop paying for an interval scan to find out.
 */

export interface WatchOptions {
  readonly config: LoadedConfig;
  /**
   * Builds and activates. Given a signal that aborts when a newer change arrives, so a
   * superseded candidate is cancelled rather than finished and thrown away.
   */
  readonly rebuild: (signal: AbortSignal) => Promise<{ readonly created: boolean }>;
  readonly warn: (text: string) => void;
  /** How long to coalesce events before acting. */
  readonly debounceMs?: number;
  /** How long size and mtime must hold still before the content is trusted. */
  readonly stabilityMs?: number;
  /** Polling interval for the stability wait. */
  readonly pollMs?: number;
  /**
   * How often to reconcile from disk regardless of what the event stream said.
   *
   * Architecture 12.3 and #54's design notes: a periodic full reconciliation catches missed
   * events without polling constantly. It is cheap because it prescreens on sizes and
   * modification times and only hashes when that moved.
   *
   * This is not belt and braces. Windows delivered no usable event for an ordinary append
   * in CI, and a watcher whose correctness depends on the event stream would simply have
   * gone on serving the old build. The stream is an accelerator; this is the floor.
   */
  readonly reconcileIntervalMs?: number;
}

export interface Watching {
  /**
   * Freshness from watcher state, costing no filesystem work.
   *
   * This is the whole point of handing it to the server. The polling revalidator exists
   * because `lore serve` has no better information; a supervisor that is watching does.
   */
  freshness(): Promise<SourceState>;
  close(): Promise<void>;
  /** Resolves once the watcher is ready and the reconciliation scan has finished. */
  readonly ready: Promise<void>;
  /** Rebuilds actually performed, for the tests that assert one save is one rebuild. */
  readonly rebuilds: number;
  /** Times a change turned out to be no change, which is a visible outcome, not a silence. */
  readonly noOps: number;
}

export const WATCH_DEFAULTS = {
  debounceMs: 150,
  stabilityMs: 120,
  pollMs: 40,
  reconcileIntervalMs: 2000,
} as const;

export function startWatching(options: WatchOptions): Watching {
  const debounceMs = options.debounceMs ?? WATCH_DEFAULTS.debounceMs;
  const stabilityMs = options.stabilityMs ?? WATCH_DEFAULTS.stabilityMs;
  const pollMs = options.pollMs ?? WATCH_DEFAULTS.pollMs;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? WATCH_DEFAULTS.reconcileIntervalMs;

  // The same rules discovery uses, so an event and a build cannot disagree about
  // whether a file is a source of this project.
  const matcher = createSourceMatcher(options.config);

  /**
   * The path the operating system will name in its own events.
   *
   * On Windows this is not a formality. A directory reached through an 8.3 short path, which
   * is what `%TEMP%` under a long user name gives you (`C:\Users\RUNNER~1\...`), makes
   * libuv abort:
   *
   *     Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
   *
   * It compares the long name the OS reports against the short name it was asked to watch,
   * they do not match, and the watcher dies. Resolving first means both sides are speaking
   * about the same string. Symlinked roots have the same shape of problem on every platform.
   */
  const watchRoot = resolveRealPath(options.config.projectRoot);
  let state: SourceState = 'clean';
  let rebuilds = 0;
  let noOps = 0;
  let closed = false;

  /** Paths seen since the last settle, so the stability wait knows what to watch. */
  let touched = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running: AbortController | null = null;
  /** A change arrived while a rebuild was in flight, so run again when it finishes. */
  let again = false;
  let chain: Promise<void> = Promise.resolve();

  const watcher = chokidarWatch(watchRoot, {
    // Chokidar v4 removed glob support and v5 has not brought it back, so it is given a
    // directory and our own matcher decides. Handing it patterns would be two matchers
    // disagreeing about which files are sources.
    ignored: (path: string) => excluded(path, watchRoot, matcher),
    // The initial scan already happened: it was the build. Replaying it as events would
    // rebuild an identical build on every startup.
    ignoreInitial: true,
    // Complementary to, not a replacement for, the stability wait below. Chokidar's version
    // decides when to *emit*; ours decides when the bytes are worth hashing, and it is the
    // one that runs against the paths a rebuild is about to read.
    awaitWriteFinish: { stabilityThreshold: stabilityMs, pollInterval: pollMs },
  });

  const ready = new Promise<void>((resolve) => {
    watcher.on('ready', () => {
      // Step 3. The scan/watch race: anything written between the build and this moment was
      // seen by neither, so the only safe assumption is that something was.
      chain = chain.then(async () => {
        await settle('startup reconciliation');
        resolve();
      });
    });
  });

  for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
    watcher.on(event, (path: string) => {
      if (closed) return;
      touched.add(path);
      schedule();
    });
  }

  watcher.on('error', (error: unknown) => {
    // A watcher that fell over must not leave the runtime confidently serving stale context.
    // Reconciling is the recovery: it re-establishes truth from content rather than from a
    // stream that has already proved unreliable.
    options.warn(
      `Watcher error: ${error instanceof Error ? error.message : String(error)}. Reconciling from disk.\n`,
    );
    chain = chain.then(() => settle('watcher recovery'));
  });

  /**
   * The floor under the event stream.
   *
   * Prescreens on paths, sizes and modification times, which is cheap, and only settles when
   * that signature moved. A platform that delivers no event still converges within one
   * interval, and a platform that delivers them promptly pays a directory scan every couple
   * of seconds and finds nothing.
   */
  let signature = '';
  const sweep = setInterval(() => {
    if (closed) return;
    const current = metadataSignature(options.config);
    if (current === signature) return;
    const first = signature === '';
    signature = current;
    // The first sweep only establishes a baseline: the build that just happened is what it
    // would otherwise mistake for a change.
    if (first) return;
    chain = chain.then(() => settle('sources changed'));
  }, reconcileIntervalMs);
  // Never hold the process open on its own account: the supervisor decides when to exit.
  sweep.unref?.();

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    // Step 4. One save is many events, and a rename is a delete plus an add. Coalescing is
    // what turns an editor's write pattern into one rebuild.
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(() => settle('sources changed'));
    }, debounceMs);
  }

  /** Steps 5 to 9, once per settled burst of events. */
  async function settle(reason: string): Promise<void> {
    if (closed) return;

    const paths = [...touched];
    touched = new Set();
    await waitForStability(paths, stabilityMs, pollMs);
    if (closed) return;

    // Whatever the sweep sees next is measured from here, so the rebuild this settle is
    // about to perform is not mistaken for a further change.
    signature = metadataSignature(options.config);

    // Step 6 and 7. The deciding evidence. A touch, an atomic rename of identical bytes, or
    // a save that changed nothing all land here and stop.
    const freshness = await readFreshness({ config: options.config });
    if (freshness.sourceState === 'clean') {
      state = 'clean';
      if (reason !== 'startup reconciliation') {
        noOps += 1;
        options.warn('No changes: the sources still match the active build.\n');
      }
      return;
    }

    state = 'dirty';
    await run(reason);
  }

  /** Steps 8 and 9, serialized, and cancelled by anything newer. */
  async function run(reason: string): Promise<void> {
    if (running !== null) {
      // Supersede: the candidate in flight is already answering an out-of-date question.
      again = true;
      running.abort();
      return;
    }

    const controller = new AbortController();
    running = controller;
    try {
      options.warn(`${reason}: rebuilding.\n`);
      const result = await options.rebuild(controller.signal);
      if (result.created) rebuilds += 1;
      state = 'clean';
    } catch (error) {
      if (controller.signal.aborted) {
        // Cancelled by a newer change. `runBuild` removes its own incomplete candidate and
        // leaves activation alone, so there is nothing to clean up and nothing to report.
        state = 'dirty';
      } else {
        // Architecture 6.9: a failed rebuild keeps the previous build active and says why.
        // Serving stale context is recoverable; exiting the supervisor is not.
        state = 'dirty';
        options.warn(
          `Rebuild failed, so the previous build is still active: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    } finally {
      running = null;
    }

    if (again && !closed) {
      again = false;
      await settle('superseded by a newer change');
    }
  }

  return {
    ready,
    get rebuilds() {
      return rebuilds;
    },
    get noOps() {
      return noOps;
    },
    async freshness() {
      return state;
    },
    async close() {
      closed = true;
      clearInterval(sweep);
      if (timer !== null) clearTimeout(timer);
      running?.abort();
      await watcher.close();
      // Let an in-flight settle unwind rather than tearing out from under it.
      await chain.catch(() => undefined);
    },
  };
}

/**
 * Step 5. Holds until size and modification time stop moving on every touched path.
 *
 * An editor that writes in chunks, and a large copy, both produce a file that exists and is
 * incomplete. Hashing it produces a real hash of the wrong bytes, a build gets created and
 * activated, and the next save produces another. Waiting is cheaper than being wrong.
 */
async function waitForStability(
  paths: readonly string[],
  stabilityMs: number,
  pollMs: number,
): Promise<void> {
  if (paths.length === 0) return;

  let previous = signature(paths);
  let stableFor = 0;
  const deadline = Date.now() + 5000;

  while (stableFor < stabilityMs && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = signature(paths);
    stableFor = current === previous ? stableFor + pollMs : 0;
    previous = current;
  }
}

/**
 * A cheap signature of the source tree: path, size and modification time.
 *
 * Evidence of nothing on its own, which is the point. A file can change without its mtime
 * moving, so this only decides whether to go and compute the hashes that do decide.
 */
function metadataSignature(config: LoadedConfig): string {
  try {
    const discovered = discover({ config, allowLargeProject: true });
    return discovered.artifacts
      .map((artifact) => {
        const path = join(config.projectRoot, artifact.relativePath);
        try {
          const stats = statSync(path);
          return `${artifact.relativePath}:${stats.size}:${stats.mtimeMs}`;
        } catch {
          return `${artifact.relativePath}:gone`;
        }
      })
      .join('\n');
  } catch {
    // A source tree that cannot be walked is not a reason to fail: returning a stable
    // marker means the sweep simply finds nothing until it can be read again.
    return 'unscannable';
  }
}

function signature(paths: readonly string[]): string {
  return paths
    .map((path) => {
      try {
        const stats = statSync(path);
        return `${path}:${stats.size}:${stats.mtimeMs}`;
      } catch {
        // Gone is a stable state: a delete is a change like any other.
        return `${path}:gone`;
      }
    })
    .join('\n');
}

/**
 * Whether a path is outside what this project indexes.
 *
 * Canonicalized to POSIX separators before matching, because the rules are written that way
 * and the paths arrive native. Architecture 12.11 states the rule generally: internal ids
 * use POSIX separators while filesystem calls use native paths.
 */
function excluded(
  path: string,
  watchRoot: string,
  matcher: { excludes: (canonicalPath: string, isDirectory?: boolean) => boolean },
): boolean {
  const relativePath = relative(watchRoot, path);
  if (relativePath === '') return false;
  // Outside the project entirely, which chokidar can ask about for a symlinked parent.
  if (relativePath.startsWith('..')) return true;

  const canonical = relativePath.split(sep).join('/');
  // Never watch our own output: a build writes into `.lore`, which would trigger a rebuild,
  // which would write into `.lore`.
  if (canonical === '.lore' || canonical.startsWith('.lore/')) return true;
  return matcher.excludes(canonical);
}

/**
 * The canonical path, or the original when it cannot be resolved.
 *
 * Falling back rather than throwing: a project that cannot be `realpath`ed is a project the
 * build has already read successfully, so refusing to watch it would be a worse answer than
 * watching it by the name we were given.
 */
export function resolveRealPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
