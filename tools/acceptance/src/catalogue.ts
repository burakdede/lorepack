import { DETERMINISM_SCENARIOS } from './scenarios/determinism.js';
import { IMMUTABILITY_SCENARIOS } from './scenarios/immutability.js';
import { INIT_SCENARIOS } from './scenarios/init.js';
import { LIFECYCLE_SCENARIOS } from './scenarios/lifecycle.js';
import { MANUAL_SCENARIOS } from './scenarios/manual.js';
import { OUTPUT_SCENARIOS } from './scenarios/output.js';
import { SCALE_SCENARIOS } from './scenarios/scale.js';
import type { Scenario } from './types.js';

export interface Area {
  readonly id: string;
  readonly title: string;
  /** What this group of scenarios is for, one sentence, rendered into the checklist. */
  readonly summary: string;
  readonly scenarios: readonly Scenario[];
}

/**
 * The catalogue.
 *
 * Ordered as a person meets the product: start a project, run the lifecycle, check it is
 * reproducible, try to break it, read its output, then push it until size matters. The
 * manual area is last because it is the part a machine cannot answer.
 */
export const AREAS: readonly Area[] = [
  {
    id: 'init',
    title: 'Starting a project',
    summary: 'First contact, and the guardrails that make a first run safe.',
    scenarios: INIT_SCENARIOS,
  },
  {
    id: 'lifecycle',
    title: 'The lifecycle',
    summary: 'plan, build, status, search, inspect, diff, activate, rollback.',
    scenarios: LIFECYCLE_SCENARIOS,
  },
  {
    id: 'determinism',
    title: 'Determinism',
    summary: 'The conditions from section 20.3 that one machine can check.',
    scenarios: DETERMINISM_SCENARIOS,
  },
  {
    id: 'immutability',
    title: 'Immutability and safety',
    summary: 'Attempts to disturb the active build, and the portable archive.',
    scenarios: IMMUTABILITY_SCENARIOS,
  },
  {
    id: 'output',
    title: 'The output contract',
    summary: 'What a script, a pipeline and a protocol can rely on.',
    scenarios: OUTPUT_SCENARIOS,
  },
  {
    id: 'scale',
    title: 'Scale and responsiveness',
    summary: 'Behaviour when there is enough work to watch.',
    scenarios: SCALE_SCENARIOS,
  },
  {
    id: 'manual',
    title: 'Checked by a person',
    summary: 'Scenarios no machine here can run, kept in the catalogue so they stay visible.',
    scenarios: MANUAL_SCENARIOS,
  },
];

export const SCENARIOS: readonly Scenario[] = AREAS.flatMap((area) => area.scenarios);

export const AUTOMATED: readonly Scenario[] = SCENARIOS.filter(
  (scenario) => scenario.mode === 'auto',
);

/** True when the scenario should not run on this platform, per its written reason. */
export function skippedHere(scenario: Scenario, platform: string = process.platform): boolean {
  return scenario.skip?.platforms.some((candidate) => candidate === platform) ?? false;
}
