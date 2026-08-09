import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ActivationReceipt,
  type Capability,
  DEPLOY_STEPS,
  type DeployApplyReporter,
  type DeploymentReceipt,
  type DeploymentTarget,
  type DeployPlan,
  type DeployStep,
  deploymentReceiptSchema,
  LORE_DIRECTORY,
  LoreError,
  type ProgressBus,
  writeFileAtomic,
} from '@lorepack/core';

/**
 * The deploy orchestration, shared by every target.
 *
 * Architecture section 16.3 lists the rules a target must obey, and this is where most of them
 * are actually enforced. That split is deliberate: a rule a target has to remember is a rule
 * some target will forget, and the one that forgets will be the one written last, by someone
 * reading a different target as an example.
 *
 * So a target **reports** and this **decides**. A target says which capabilities it can serve;
 * this refuses the deploy. A target says what its plan would do; this prints it and stops when
 * asked. A target writes candidate data; this is what insists verification ran against the
 * candidate before activation is even offered.
 *
 * Section 18.5 fixes the sequence:
 *
 *     status -> plan -> build if dirty -> project candidate -> verify -> activate -> smoke -> receipt
 *
 * `build if dirty` belongs to the caller, because deploying is not the only thing that needs
 * it and `--no-build` is a flag about the caller's intent rather than about the target.
 */

export interface DeployOptions {
  readonly target: DeploymentTarget;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly buildId: string;
  readonly buildDirectory: string;
  readonly buildCapabilities: readonly Capability[];
  readonly progress: ProgressBus;
  readonly plan?: DeployPlan;
  /** Stop after printing the plan. Nothing remote is touched, which is the point. */
  readonly dryRun?: boolean;
  /**
   * Capabilities the user has accepted losing, **by name**.
   *
   * Section 16.3 says a named override per capability, never a blanket `--force`. The
   * difference matters: `--force` is a habit, and a habit that silently drops table queries
   * from a deployment is exactly what capability negotiation exists to prevent.
   */
  readonly allowCapabilityLoss?: readonly Capability[];
  /** A receipt to continue from, so a partial deploy resumes rather than restarts. */
  readonly resume?: DeploymentReceipt;
  /**
   * Test-only hook for forcing a resumable failure after candidate projection completed.
   *
   * The hook lives at the orchestration boundary so acceptance can interrupt a real target
   * after the projected receipt was written, while production callers omit it entirely.
   */
  readonly afterProject?: ((receipt: DeploymentReceipt) => Promise<void> | void) | undefined;
  readonly now?: () => Date;
}

export interface DeployResult {
  readonly receipt: DeploymentReceipt;
  readonly plan: DeployPlan;
  /** Absent on a dry run, which is how a caller knows nothing was activated. */
  readonly activation?: ActivationReceipt;
  readonly dryRun: boolean;
}

/** Where receipts live. Local, under `.lore/`, so a resume needs nothing remote to find. */
export function receiptsDirectory(projectRoot: string): string {
  return join(projectRoot, LORE_DIRECTORY, 'receipts');
}

export function receiptPath(projectRoot: string, receiptId: string): string {
  return join(receiptsDirectory(projectRoot), `${receiptId}.json`);
}

/**
 * Reads a receipt to resume from, validated against the committed schema.
 *
 * Validated rather than trusted because a receipt is a file on disk that a person can edit,
 * and a resume driven by a malformed one would replay the wrong steps against a live target.
 */
export function readReceipt(projectRoot: string, receiptId: string): DeploymentReceipt {
  const path = receiptPath(projectRoot, receiptId);
  if (!existsSync(path)) {
    throw new LoreError('LORE_E_BUILD_NOT_FOUND', `No deployment receipt ${receiptId}.`, {
      // Deliberately naming no command: `lore deploy` and `lore target` arrive with #91 and
      // #85, and a remediation pointing at a command that does not exist is worse than one
      // that describes the action. These become command names when those tickets land.
      remediation: 'Check the receipt id, or deploy again from the start.',
      subject: receiptId,
    });
  }
  const parsed = deploymentReceiptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new LoreError('LORE_E_BUILD_VALIDATION', `Receipt ${receiptId} is not readable.`, {
      remediation: 'Deploy again from the start. A receipt is a record, so losing one is safe.',
      subject: receiptId,
    });
  }
  return parsed.data;
}

function writeReceipt(projectRoot: string, receipt: DeploymentReceipt): void {
  mkdirSync(receiptsDirectory(projectRoot), { recursive: true });
  writeFileAtomic(
    receiptPath(projectRoot, receipt.receiptId),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

/** Steps already done, so a resume skips them rather than repeating a remote write. */
function done(receipt: DeploymentReceipt | undefined, step: DeployStep): boolean {
  return receipt?.completedSteps.includes(step) === true;
}

export async function runDeploy(options: DeployOptions): Promise<DeployResult> {
  const { target, progress } = options;
  const now = options.now ?? (() => new Date());
  const accepted = options.allowCapabilityLoss ?? [];

  const detection = await target.detect();
  if (!detection.installed) {
    throw new LoreError(
      'LORE_E_TARGET_NOT_CONFIGURED',
      `The ${target.id} target is not usable here: ${detection.reason ?? 'it reported no reason'}.`,
      {
        remediation: `Set up the ${target.id} target before deploying to it.`,
        subject: target.id,
      },
    );
  }

  // `validating` rather than a new stage name: the stage set is closed on purpose, and what
  // planning does here is check a build against a target without changing either.
  let plan = options.plan;
  if (plan === undefined) {
    progress.start('validating', 'Planning', 1);
    plan = await target.plan({
      projectName: options.projectName,
      buildId: options.buildId as DeployPlan['input']['buildId'],
      buildDirectory: options.buildDirectory,
      buildCapabilities: options.buildCapabilities,
    });
    progress.finish('validating', 1);
  }

  /**
   * Capability loss fails by default, and the override is per capability.
   *
   * Checked here rather than in a target so it cannot be forgotten by one, and checked
   * **before** anything is applied so the refusal costs nothing.
   */
  const unaccepted = plan.capabilityLoss.filter((capability) => !accepted.includes(capability));
  if (unaccepted.length > 0) {
    throw new LoreError(
      'LORE_E_CAPABILITY_LOSS',
      `This build uses ${unaccepted.join(', ')}, which the ${target.id} target cannot serve.`,
      {
        remediation: `Deploying would answer fewer questions than the local build does. Accept each one by name to continue: ${unaccepted
          .map((capability) => `--allow-capability-loss ${capability}`)
          .join(' ')}`,
        details: { lost: unaccepted },
      },
    );
  }

  const receiptId = options.resume?.receiptId ?? `${target.id}-${options.buildId.slice(5, 17)}`;
  let receipt: DeploymentReceipt = options.resume ?? {
    formatVersion: 1,
    receiptId,
    target: target.id,
    project: options.projectName,
    buildId: options.buildId as DeploymentReceipt['buildId'],
    previousBuildId: null,
    state: 'planned',
    deployedAt: now().toISOString(),
    endpoint: plan.endpoint,
    capabilityLossAccepted: [...accepted],
    completedSteps: ['plan'],
    ...(plan.transfer === undefined ? {} : { transfer: plan.transfer }),
    verification: { search: 'skipped', sourceRead: 'skipped', tableQuery: 'skipped' },
  };

  if (options.dryRun === true) {
    // Deliberately not written to disk. A dry run that left a receipt behind would make
    // `--resume` offer to continue something that never started.
    return { receipt, plan, dryRun: true };
  }

  writeReceipt(options.projectRoot, receipt);

  // Project the candidate. Build-scoped only, so nothing a reader can see changes yet.
  if (!done(options.resume, 'project')) {
    let projectionStarted = false;
    let uploadStarted = false;
    let projectionCompleted = 0;
    let uploadCompleted = 0;
    const reportApplyProgress: DeployApplyReporter = (update) => {
      if (update.stage === 'projecting') {
        if (!projectionStarted) {
          progress.start('projecting', 'Projecting', update.total);
          projectionStarted = true;
        }
        projectionCompleted = update.completed;
        progress.progress('projecting', update.completed, {
          ...(update.total === undefined ? {} : { total: update.total }),
          ...(update.unit === undefined ? {} : { unit: update.unit }),
          ...(update.detail === undefined ? {} : { detail: update.detail }),
        });
        return;
      }

      if (!uploadStarted) {
        progress.start('uploading', 'Uploading', update.total);
        uploadStarted = true;
      }
      uploadCompleted = update.completed;
      progress.progress('uploading', update.completed, {
        ...(update.total === undefined ? {} : { total: update.total }),
        ...(update.unit === undefined ? {} : { unit: update.unit }),
        ...(update.detail === undefined ? {} : { detail: update.detail }),
      });
    };
    let applied: DeploymentReceipt;
    try {
      applied = await target.apply(plan, options.resume, reportApplyProgress);
    } catch (error) {
      const partial = partialReceipt(error);
      if (partial !== null) writeReceipt(options.projectRoot, partial);
      throw error;
    }
    /**
     * Merged, not replaced. The orchestration owns what it decided.
     *
     * A target returns a receipt describing what it wrote, and taking it wholesale let it
     * erase fields that are not its to set: the first version of this dropped
     * `capabilityLossAccepted`, so a deploy that gave up a capability recorded that it had
     * not. The same shape would let a target rewrite the build id or the accepted losses,
     * which is precisely the "a target reports, this decides" split this file exists for.
     */
    receipt = {
      ...applied,
      buildId: receipt.buildId,
      project: receipt.project,
      target: receipt.target,
      receiptId: receipt.receiptId,
      capabilityLossAccepted: receipt.capabilityLossAccepted,
      ...(applied.transfer === undefined && receipt.transfer !== undefined
        ? { transfer: receipt.transfer }
        : {}),
      state: 'projected',
      completedSteps: steps(applied, 'project'),
    };
    writeReceipt(options.projectRoot, receipt);
    await options.afterProject?.(receipt);
    progress.finish('projecting', projectionStarted ? projectionCompleted : plan.steps.length);
    if (uploadStarted) {
      progress.finish('uploading', uploadCompleted);
    }
  }

  /**
   * Verify the candidate, before activation is even offered.
   *
   * Section 16.3 says `verify` must query the candidate explicitly. The orchestration cannot
   * check that a target did so, but it can guarantee the *order*: nothing is activated that
   * was not verified first, and a verification that failed stops here with the previous build
   * still serving.
   */
  if (!done(options.resume, 'verify')) {
    progress.start('verifying', 'Verifying', 1);
    const verification = await target.verify(receipt);
    receipt = {
      ...receipt,
      state: 'verified',
      ...(verification.capabilities === undefined
        ? {}
        : { verifiedCapabilities: [...verification.capabilities] }),
      verification: {
        search: verification.search,
        sourceRead: verification.sourceRead,
        tableQuery: verification.tableQuery,
      },
      completedSteps: steps(receipt, 'verify'),
    };
    writeReceipt(options.projectRoot, receipt);
    progress.finish('verifying', 1);

    const failed = Object.entries(receipt.verification)
      .filter(([, outcome]) => outcome === 'failed')
      .map(([what]) => what);
    if (failed.length > 0) {
      const failedReceipt = { ...receipt, state: 'failed' as const };
      writeReceipt(options.projectRoot, failedReceipt);
      throw new LoreError(
        'LORE_E_REMOTE_DEPLOY',
        `The candidate failed verification: ${failed.join(', ')}.`,
        {
          remediation: `Nothing was activated and the previous build is still serving. ${
            verification.failures?.join(' ') ?? ''
          }`.trim(),
          details: { receiptId: receipt.receiptId, failed },
        },
      );
    }
  }

  // The smallest possible pointer mutation, and the only step that changes what a reader sees.
  progress.start('activating', 'Activating', 1);
  const activation = await target.activate(receipt);
  progress.finish('activating', 1);

  const activatedReceipt = {
    ...receipt,
    previousBuildId: activation.previousBuildId,
    endpoint: activation.endpoint,
    completedSteps: steps(receipt, 'activate'),
  };

  /**
   * The smoke check, which is the difference between "the write returned" and "it is serving".
   *
   * A target confirms by querying its own public endpoint, so a pointer that was written and
   * not picked up is caught here rather than by a user. A target that cannot confirm returns
   * null, and that is recorded rather than treated as success.
   */
  if (activation.confirmedBuildId !== null && activation.confirmedBuildId !== options.buildId) {
    const failedReceipt = { ...activatedReceipt, state: 'failed' as const };
    writeReceipt(options.projectRoot, failedReceipt);
    throw new LoreError(
      'LORE_E_REMOTE_DEPLOY',
      `The endpoint is serving ${activation.confirmedBuildId}, not the build that was just activated.`,
      {
        remediation:
          'The pointer was written but the endpoint did not pick it up. Check the target, then deploy again; the projected candidate is still there and will be reused.',
        details: { expected: options.buildId, serving: activation.confirmedBuildId },
      },
    );
  }

  receipt = {
    ...activatedReceipt,
    state: 'active',
    deployedAt: now().toISOString(),
    completedSteps: steps(activatedReceipt, 'smoke'),
  };
  writeReceipt(options.projectRoot, receipt);

  return { receipt, plan, activation, dryRun: false };
}

/** Appends a step once, in the order section 18.5 fixes, so a resume reads them back reliably. */
function steps(receipt: DeploymentReceipt, step: DeployStep): string[] {
  const present = new Set(receipt.completedSteps);
  present.add(step);
  return DEPLOY_STEPS.filter((known) => present.has(known));
}

function partialReceipt(error: unknown): DeploymentReceipt | null {
  if (typeof error !== 'object' || error === null || !('receipt' in error)) return null;
  const parsed = deploymentReceiptSchema.safeParse((error as { receipt: unknown }).receipt);
  return parsed.success ? parsed.data : null;
}
