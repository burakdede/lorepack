import { statSync } from 'node:fs';
import { join } from 'node:path';
import { discover } from '@lorepack/compiler';
import type { LoadedConfig, SourceState } from '@lorepack/core';
import { readFreshness } from './status.js';

/**
 * Keeping a long-lived server honest about freshness, without paying for it every request.
 *
 * An open MCP connection is not a session (2026-07-28), so a process can serve one
 * conversation for an hour. Checking freshness once at startup would let it report `clean`
 * for that entire hour while the sources moved underneath it.
 *
 * Checking properly on every request is the other failure. Content hashing every artifact
 * is what dominates a no-op build, and at the 50,000-chunk envelope, on bursty agent
 * traffic, that is seconds of work to annotate a result that took milliseconds.
 *
 * So: an interval, and a cheap prescreen inside it. Architecture 12.3 permits size and
 * mtime as a **prescreen** while keeping content hashes as the deciding evidence, which is
 * exactly this case. A scan that finds nothing moved answers from cache; a scan that finds
 * something calls the real, hashing check.
 */

export interface RevalidatorOptions {
  readonly config: LoadedConfig;
  /** Milliseconds between checks. `0` checks every request. */
  readonly intervalMs: number;
  /** Never checks. The answer is whatever the first one was. */
  readonly frozen?: boolean;
  readonly now?: () => number;
}

export interface Revalidator {
  /** The freshness to stamp on a response, cheap enough to call per request. */
  freshness(): Promise<SourceState>;
  /** How many full, hashing checks have run. The test for "no filesystem work" reads it. */
  readonly deepChecks: number;
  /** How many cheap metadata scans have run. */
  readonly prescreens: number;
}

export const DEFAULT_REVALIDATE_INTERVAL_MS = 5000;

export function createRevalidator(options: RevalidatorOptions): Revalidator {
  const now = options.now ?? Date.now;
  let cached: SourceState = 'unknown';
  let checkedAt = Number.NEGATIVE_INFINITY;
  let signature = '';
  let deepChecks = 0;
  let prescreens = 0;
  let started = false;

  const state: Revalidator = {
    get deepChecks() {
      return deepChecks;
    },
    get prescreens() {
      return prescreens;
    },
    async freshness(): Promise<SourceState> {
      if (options.frozen === true) return 'unknown';

      const elapsed = now() - checkedAt;
      if (started && elapsed < options.intervalMs) return cached;

      // The prescreen: sizes and modification times only, no file contents. It cannot
      // prove the sources are unchanged, which is why a difference sends us to the real
      // check rather than being reported directly (architecture 12.3).
      const scanned = scan(options.config);
      prescreens += 1;
      checkedAt = now();

      if (started && scanned === signature) return cached;

      signature = scanned;
      deepChecks += 1;
      started = true;
      cached = (await readFreshness({ config: options.config })).sourceState;
      return cached;
    },
  };

  return state;
}

/**
 * A cheap signature of the source tree: path, size and modification time.
 *
 * Deliberately not evidence of anything on its own. A file can change without its mtime
 * moving, which is the reason content hashes decide freshness, and this only decides
 * whether to go and compute them.
 */
function scan(config: LoadedConfig): string {
  try {
    const discovered = discover({ config, allowLargeProject: true });
    const parts: string[] = [];
    for (const artifact of discovered.artifacts) {
      try {
        const stats = statSync(join(config.projectRoot, artifact.relativePath));
        parts.push(`${artifact.relativePath}:${stats.size}:${stats.mtimeMs}`);
      } catch {
        // A file that vanished between discovery and stat is a change by itself.
        parts.push(`${artifact.relativePath}:gone`);
      }
    }
    return parts.join('\n');
  } catch {
    // A source tree that cannot be walked is not a reason to fail a read (#147). Returning
    // a distinct value sends the caller to the real check, which degrades properly.
    return `unscannable:${Math.random()}`;
  }
}
