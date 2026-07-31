export { PHASE_0 } from './phases/phase-0.js';
export { PHASES, phaseDefinition } from './registry.js';
export { checkCriterion, checkPhase, formatReport, type RunOptions } from './run.js';
export type {
  AuditCriterion,
  Criterion,
  CriterionKind,
  CriterionResult,
  Outcome,
  PhaseDefinition,
  PhaseReport,
} from './types.js';
export { EXIT } from './types.js';
