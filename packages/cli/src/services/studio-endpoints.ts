import { createPlan, readLockfile } from '@lorepack/compiler';
import { type BuildWarning, type LoadedConfig, ProgressBus } from '@lorepack/core';
import { readPreviousBuild } from './project.js';
import { lockInputs } from './versions.js';

/**
 * The reads Studio needs that are not runtime capabilities.
 *
 * Architecture 13.1 fixes `LoreRuntime` at seven capabilities, and every one of them reads
 * the **active build**. A plan reads the **source tree**, and warnings are a property of a
 * build's manifest rather than a query against its content. Neither belongs in that
 * interface, and adding them would change what every backend has to implement, including the
 * Phase 6 Worker that has no sources to plan against.
 *
 * So they are injected host functions on `createApiApp`, exactly like `currentBuild`. A
 * deployment that cannot answer simply does not register the route.
 *
 * Both call the same code the CLI calls, so `lore plan` and Studio can never disagree.
 */

/**
 * What a rebuild would change.
 *
 * Progress goes to a bus nobody is subscribed to. The CLI renders a stage table here because
 * a person is watching a terminal; an HTTP caller gets one JSON answer when it is ready, and
 * a half-rendered progress stream would be noise in it.
 */
export function createPlanEndpoint(config: LoadedConfig): () => Promise<unknown> {
  return async () => {
    // `readPreviousBuild` reads the pointer without opening the state store for writing, so
    // there is no handle to release here and a plan cannot block a build.
    const { previous } = readPreviousBuild(config);
    {
      const { plan } = await createPlan({
        config,
        previous,
        previousLock: readLockfile(config.projectRoot),
        lockInputs: lockInputs(),
        progress: new ProgressBus(),
        // A person asking Studio what a rebuild would change wants an answer, not a refusal
        // about the envelope. The build itself still enforces it.
        allowLargeProject: true,
      });
      return plan;
    }
  };
}

export interface WarningGroup {
  readonly class: BuildWarning['class'];
  readonly count: number;
  readonly warnings: readonly BuildWarning[];
}

export interface WarningSummary {
  readonly buildId: string;
  readonly total: number;
  readonly groups: readonly WarningGroup[];
}

/**
 * The active build's warnings, grouped by class.
 *
 * Grouped on the server so the CLI and Studio agree about what a class is, and because a
 * client that receives a flat list has to invent the grouping, which is how two surfaces come
 * to count the same thing differently.
 */
export function createWarningsEndpoint(
  read: () => Promise<{ buildId: string; warnings: readonly BuildWarning[] }>,
): () => Promise<WarningSummary> {
  return async () => {
    const { buildId, warnings } = await read();

    const byClass = new Map<BuildWarning['class'], BuildWarning[]>();
    for (const warning of warnings) {
      const existing = byClass.get(warning.class);
      if (existing === undefined) byClass.set(warning.class, [warning]);
      else existing.push(warning);
    }

    return {
      buildId,
      total: warnings.length,
      // Sorted by count, then by name, so the display order is stable across requests and
      // the largest group is where the eye lands first.
      groups: [...byClass.entries()]
        .map(([warningClass, group]) => ({
          class: warningClass,
          count: group.length,
          warnings: group,
        }))
        .sort((left, right) => right.count - left.count || left.class.localeCompare(right.class)),
    };
  };
}
