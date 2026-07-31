/**
 * A phase's acceptance criteria, as data.
 *
 * The epic issue states the intent for humans. This is the executable mirror, so the
 * question "is this phase still satisfied?" is a command rather than a memory. Every
 * criterion names the promise it enforces, so a failure reads as a broken guarantee
 * rather than as a broken assertion.
 */

export type CriterionKind = 'command' | 'exports' | 'path' | 'issues';

interface BaseCriterion {
  /** Stable identifier, referenced by the report and by CI output. */
  readonly id: string;
  /** The promise, in the phase's own words. */
  readonly promise: string;
}

export interface CommandCriterion extends BaseCriterion {
  readonly kind: 'command';
  readonly command: string;
  readonly args: readonly string[];
  /** Some checks are slow; a bound keeps a hung command from hanging the gate. */
  readonly timeoutMs?: number;
}

export interface ExportsCriterion extends BaseCriterion {
  readonly kind: 'exports';
  /** Import specifier resolved from the repository root. */
  readonly module: string;
  readonly symbols: readonly string[];
}

export interface PathCriterion extends BaseCriterion {
  readonly kind: 'path';
  readonly paths: readonly string[];
}

export interface IssuesCriterion extends BaseCriterion {
  readonly kind: 'issues';
  readonly milestone: string;
  /** Issues expected to remain open, such as the epic itself while work continues. */
  readonly allowOpen?: readonly number[];
}

export type Criterion = CommandCriterion | ExportsCriterion | PathCriterion | IssuesCriterion;

export interface PhaseDefinition {
  readonly phase: number;
  readonly title: string;
  readonly epic: number;
  readonly criteria: readonly Criterion[];
}

export type Outcome = 'passed' | 'failed' | 'unverified';

export interface CriterionResult {
  readonly id: string;
  readonly promise: string;
  readonly outcome: Outcome;
  /** What was actually checked, so a passing gate is auditable rather than trusted. */
  readonly evidence: string;
  readonly detail?: string;
}

export interface PhaseReport {
  readonly phase: number;
  readonly title: string;
  readonly epic: number;
  readonly outcome: Outcome;
  readonly results: readonly CriterionResult[];
  readonly counts: { passed: number; failed: number; unverified: number };
}

/**
 * Exit codes are distinct because the three outcomes need different reactions: a failure
 * is a regression to fix, an unverified criterion is a gap in the gate itself.
 */
export const EXIT = { passed: 0, failed: 1, unverified: 2 } as const;
