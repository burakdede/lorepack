import type { BuildId } from '../hash/build-id.js';
import type { Capability } from '../schemas/common.js';
import type { DeploymentReceipt } from '../schemas/plan.js';

/**
 * The deployment target contract, architecture section 16.3 exactly.
 *
 * One port, so every target inherits the same safety semantics rather than restating them.
 * Section 16.4 lists the siblings this exists for (Docker, PostgreSQL, Lambda, Kubernetes);
 * none is a v0.1 deliverable, which is precisely why the shape is fixed now. A contract
 * written against one implementation is a description of that implementation.
 *
 * Every rule in 16.3 is expressed here as a type or enforced by the orchestration that calls
 * it, never left to a target to remember:
 *
 * - `plan` is **read-only**. It reports what would happen and writes nothing remote.
 * - **Capability loss fails by default.** The orchestration compares and refuses; a target
 *   only reports.
 * - `apply` writes **only build-scoped candidate data**, so a failed deploy cannot be seen.
 * - `verify` must query the **candidate** explicitly, not whatever is currently active.
 * - `activate` is the **smallest possible pointer mutation**.
 * - Receipts are **resumable and serializable**, which is why they are a schema rather than
 *   an object graph.
 * - A target may **never** change canonical build contents.
 *
 * A target is registered explicitly (section 4.8: no dynamic discovery in v0.1), so the set a
 * deploy can reach is visible in one place and reviewable in a diff.
 */

/** Whether the tooling a target needs is present, and what it found. */
export interface TargetDetection {
  readonly installed: boolean;
  /** The version of whatever the target depends on, when it can say. */
  readonly version?: string;
  /**
   * Why it is unusable, when it is.
   *
   * Present exactly when `installed` is false, and phrased for a person: "the `wrangler`
   * command was not found" rather than `ENOENT`.
   */
  readonly reason?: string;
}

/**
 * What a target can serve.
 *
 * Compared against the build's own capabilities, which is the whole of capability
 * negotiation. A target that cannot answer table queries is not broken, and deploying a build
 * containing tables to it is a **loss** the user has to accept by name.
 */
export interface TargetCapabilities {
  readonly supported: readonly Capability[];
  /** Where the deployed build will answer, when the target knows before it is applied. */
  readonly endpoint?: string;
}

/** What the orchestration hands a target when asking what a deploy would do. */
export interface DeployInput {
  readonly projectName: string;
  readonly buildId: BuildId;
  /** The sealed build directory. A target reads from it and never writes to it. */
  readonly buildDirectory: string;
  /** The capabilities the build itself declares, from its manifest. */
  readonly buildCapabilities: readonly Capability[];
}

/**
 * What would happen, computed without touching anything remote.
 *
 * `capabilityLoss` is the target's report, not its decision. Refusing is the orchestration's
 * job, so a target cannot accidentally ship a deploy that silently drops a capability by
 * forgetting to check.
 */
export interface DeployPlan {
  readonly target: string;
  readonly input: DeployInput;
  /** Capabilities the build has and the target cannot serve. */
  readonly capabilityLoss: readonly Capability[];
  /** One line per remote change, in the order it would happen, for a person to read. */
  readonly steps: readonly string[];
  readonly endpoint: string | null;
}

/** What a verification actually asked the candidate, per capability. */
export interface VerificationResult {
  readonly search: 'passed' | 'failed' | 'skipped';
  readonly sourceRead: 'passed' | 'failed' | 'skipped';
  readonly tableQuery: 'passed' | 'failed' | 'skipped';
  /** Why something failed, for the receipt and for the person reading it. */
  readonly failures?: readonly string[];
}

/**
 * What activation returned, including the build the target was serving before it.
 *
 * `previousBuildId` is the target's answer rather than the orchestration's guess, because only
 * the target knows what it was actually serving. A rollback that trusted a local guess would
 * roll back to something that was never there.
 */
export interface ActivationReceipt {
  readonly buildId: BuildId;
  readonly previousBuildId: BuildId | null;
  /** Confirmed by querying the public endpoint, not by assuming the write landed. */
  readonly confirmedBuildId: BuildId | null;
  readonly endpoint: string | null;
}

export interface DeploymentTarget {
  readonly id: string;
  detect(): Promise<TargetDetection>;
  capabilities(): Promise<TargetCapabilities>;
  /** Read-only. Nothing remote changes, which is asserted rather than trusted. */
  plan(input: DeployInput): Promise<DeployPlan>;
  /** Writes only build-scoped candidate data. The active build is untouched. */
  apply(plan: DeployPlan, resume?: DeploymentReceipt): Promise<DeploymentReceipt>;
  /** Queries the candidate explicitly, never whatever happens to be active. */
  verify(receipt: DeploymentReceipt): Promise<VerificationResult>;
  /** The smallest possible pointer mutation, and nothing else. */
  activate(receipt: DeploymentReceipt): Promise<ActivationReceipt>;
  rollback(buildId: BuildId): Promise<ActivationReceipt>;
}

/**
 * The steps a deploy records, in the order section 18.5 fixes them.
 *
 * Named rather than free strings because `--resume` reads them back: a receipt whose steps are
 * whatever a target felt like writing cannot be resumed by anything but that target.
 */
export const DEPLOY_STEPS = ['plan', 'project', 'verify', 'activate', 'smoke'] as const;

export type DeployStep = (typeof DEPLOY_STEPS)[number];
