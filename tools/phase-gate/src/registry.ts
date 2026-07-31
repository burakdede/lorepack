import { PHASE_0 } from './phases/phase-0.js';
import { PHASE_1 } from './phases/phase-1.js';
import type { PhaseDefinition } from './types.js';

/**
 * Phases with executable criteria. A phase without a definition here has not been given
 * a gate yet, which the runner reports rather than treating as satisfied.
 */
export const PHASES: readonly PhaseDefinition[] = [PHASE_0, PHASE_1];

export function phaseDefinition(phase: number): PhaseDefinition | null {
  return PHASES.find((definition) => definition.phase === phase) ?? null;
}
