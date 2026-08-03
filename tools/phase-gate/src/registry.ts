import { PHASE_0 } from './phases/phase-0.js';
import { PHASE_1 } from './phases/phase-1.js';
import { PHASE_2 } from './phases/phase-2.js';
import { PHASE_3 } from './phases/phase-3.js';
import { PHASE_4 } from './phases/phase-4.js';
import type { PhaseDefinition } from './types.js';

/**
 * Phases with executable criteria. A phase without a definition here has not been given
 * a gate yet, which the runner reports rather than treating as satisfied.
 */
export const PHASES: readonly PhaseDefinition[] = [PHASE_0, PHASE_1, PHASE_2, PHASE_3, PHASE_4];

export function phaseDefinition(phase: number): PhaseDefinition | null {
  return PHASES.find((definition) => definition.phase === phase) ?? null;
}
