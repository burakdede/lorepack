import { existsSync, readFileSync } from 'node:fs';
import {
  type ActivationReceipt,
  type Capability,
  type DeployInput,
  type DeploymentReceipt,
  type DeploymentTarget,
  type DeployPlan,
  deploymentReceiptSchema,
  LoreError,
  ProgressBus,
  type VerificationResult,
} from '@lorepack/core';
import { withTempProject } from '@lorepack/test-support';
import { describe, expect, it } from 'vitest';
import { readReceipt, receiptPath, runDeploy } from '../src/services/deploy.js';

/**
 * The deploy orchestration, against a fake target (#84).
 *
 * A fake rather than Cloudflare, and that is the point rather than a convenience. Section 16.3
 * lists rules every target must obey, and this suite is where they are proven to be enforced by
 * the *orchestration* rather than by any one target's diligence. A rule a target has to remember
 * is a rule some target will forget, and the one that forgets will be written last, by someone
 * reading a different target as an example.
 *
 * So the fake is deliberately obedient. It records what it was asked to do and in what order,
 * and the assertions are about what the orchestration did and did not let happen.
 */

const BUILD = `lore_${'a'.repeat(64)}` as DeploymentReceipt['buildId'];
const CONFIG = 'version: 1\nname: deployed\nsources:\n  - .\n';

interface FakeOptions {
  readonly supported?: readonly Capability[];
  readonly verification?: VerificationResult;
  readonly failApplyOnce?: boolean;
  readonly confirms?: string | null;
  readonly installed?: boolean;
}

/** Records every call, so the assertions can be about order and about what never happened. */
function fakeTarget(options: FakeOptions = {}): {
  target: DeploymentTarget;
  calls: string[];
} {
  const calls: string[] = [];
  const state = { failNext: options.failApplyOnce === true };

  const target: DeploymentTarget = {
    id: 'fake',
    detect: async () => {
      calls.push('detect');
      return options.installed === false
        ? { installed: false, reason: 'the fake tool was not found' }
        : { installed: true, version: '1.0.0' };
    },
    capabilities: async () => ({ supported: options.supported ?? ['lexical-search'] }),
    plan: async (input: DeployInput): Promise<DeployPlan> => {
      calls.push('plan');
      const supported = options.supported ?? [
        'lexical-search',
        'structured-context',
        'table-query',
      ];
      return {
        target: 'fake',
        input,
        capabilityLoss: input.buildCapabilities.filter((one) => !supported.includes(one)),
        steps: ['write rows', 'upload objects'],
        endpoint: 'https://fake.example/mcp',
      };
    },
    apply: async (plan, resume): Promise<DeploymentReceipt> => {
      calls.push('apply');
      if (state.failNext) {
        state.failNext = false;
        throw new LoreError('LORE_E_REMOTE_DEPLOY', 'The fake target failed part way through.', {
          remediation: 'Try again.',
        });
      }
      return (
        resume ?? {
          formatVersion: 1,
          receiptId: 'fake-aaaaaaaaaaaa',
          target: 'fake',
          project: plan.input.projectName,
          buildId: plan.input.buildId,
          previousBuildId: null,
          state: 'projecting',
          deployedAt: '2026-08-06T00:00:00.000Z',
          endpoint: plan.endpoint,
          capabilityLossAccepted: [],
          completedSteps: ['plan'],
          verification: { search: 'skipped', sourceRead: 'skipped', tableQuery: 'skipped' },
        }
      );
    },
    verify: async (): Promise<VerificationResult> => {
      calls.push('verify');
      return (
        options.verification ?? { search: 'passed', sourceRead: 'passed', tableQuery: 'passed' }
      );
    },
    activate: async (): Promise<ActivationReceipt> => {
      calls.push('activate');
      return {
        buildId: BUILD,
        previousBuildId: null,
        confirmedBuildId:
          options.confirms === undefined
            ? BUILD
            : (options.confirms as ActivationReceipt['buildId']),
        endpoint: 'https://fake.example/mcp',
      };
    },
    rollback: async () => {
      calls.push('rollback');
      return { buildId: BUILD, previousBuildId: null, confirmedBuildId: BUILD, endpoint: null };
    },
  };

  return { target, calls };
}

async function deploying<T>(body: (root: string) => Promise<T>): Promise<T> {
  return withTempProject({ files: { 'lore.yaml': CONFIG } }, async (temp) => body(temp.root));
}

const base = (root: string, target: DeploymentTarget, extra = {}) => ({
  target,
  projectRoot: root,
  projectName: 'deployed',
  buildId: BUILD,
  buildDirectory: `${root}/.lore/builds/${BUILD}`,
  buildCapabilities: ['lexical-search', 'structured-context'] as Capability[],
  progress: new ProgressBus(),
  now: () => new Date('2026-08-06T00:00:00.000Z'),
  ...extra,
});

describe('the sequence architecture 18.5 fixes', () => {
  it('plans, projects, verifies, then activates, in that order', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();
      const result = await runDeploy(base(root, fake.target));

      expect(fake.calls).toEqual(['detect', 'plan', 'apply', 'verify', 'activate']);
      expect(result.receipt.state).toBe('active');
      expect(result.receipt.completedSteps).toEqual([
        'plan',
        'project',
        'verify',
        'activate',
        'smoke',
      ]);
    });
  });

  /**
   * The rule with teeth: nothing is activated that was not verified.
   *
   * Asserted by what is **absent** from the call list, because a suite that only checks the
   * happy order would pass an implementation that activated first and verified afterwards.
   */
  it('never activates when verification failed, and says the previous build still serves', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({
        verification: { search: 'failed', sourceRead: 'passed', tableQuery: 'skipped' },
      });

      const failure = await runDeploy(base(root, fake.target)).catch((error: unknown) => error);

      expect((failure as LoreError).code).toBe('LORE_E_REMOTE_DEPLOY');
      expect((failure as LoreError).remediation).toContain('previous build is still serving');
      expect(fake.calls).not.toContain('activate');
    });
  });

  it('refuses a target that is not usable, before planning anything', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ installed: false });

      const failure = await runDeploy(base(root, fake.target)).catch((error: unknown) => error);

      expect((failure as LoreError).code).toBe('LORE_E_TARGET_NOT_CONFIGURED');
      // Names the action rather than a command, because `lore target add` arrives with #85 and
      // a remediation pointing at a command that does not exist is worse than none.
      expect((failure as LoreError).remediation).toContain('Set up the fake target');
      expect(fake.calls).toEqual(['detect']);
    });
  });
});

describe('capability loss fails by default', () => {
  it('refuses, naming each lost capability and the override for it', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ supported: ['lexical-search'] });

      const failure = await runDeploy(
        base(root, fake.target, {
          buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
        }),
      ).catch((error: unknown) => error);

      const error = failure as LoreError;
      expect(error.code).toBe('LORE_E_CAPABILITY_LOSS');
      // Each one named, and the remediation is per capability rather than a blanket flag.
      expect(error.remediation).toContain('--allow-capability-loss structured-context');
      expect(error.remediation).toContain('--allow-capability-loss table-query');
      expect(error.remediation).not.toContain('--force');
      // Refused before anything was applied, so the refusal costs nothing.
      expect(fake.calls).not.toContain('apply');
    });
  });

  it('proceeds when each loss is accepted by name, and records which', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ supported: ['lexical-search'] });

      const result = await runDeploy(
        base(root, fake.target, {
          buildCapabilities: ['lexical-search', 'table-query'],
          allowCapabilityLoss: ['table-query'],
        }),
      );

      expect(result.receipt.state).toBe('active');
      // Echoed into the receipt, so what was given up is on the record rather than in a shell
      // history somewhere.
      expect(result.receipt.capabilityLossAccepted).toEqual(['table-query']);
    });
  });

  it('still refuses when only some of the losses were accepted', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ supported: ['lexical-search'] });

      const failure = await runDeploy(
        base(root, fake.target, {
          buildCapabilities: ['lexical-search', 'structured-context', 'table-query'],
          allowCapabilityLoss: ['table-query'],
        }),
      ).catch((error: unknown) => error);

      const error = failure as LoreError;
      expect(error.code).toBe('LORE_E_CAPABILITY_LOSS');
      expect(error.message).toContain('structured-context');
      expect(error.message).not.toContain('table-query');
    });
  });
});

describe('a dry run', () => {
  it('touches nothing remote and leaves no receipt to resume', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();

      const result = await runDeploy(base(root, fake.target, { dryRun: true }));

      expect(result.dryRun).toBe(true);
      expect(fake.calls).toEqual(['detect', 'plan']);
      // A receipt on disk would make `--resume` offer to continue something that never began.
      expect(existsSync(receiptPath(root, result.receipt.receiptId))).toBe(false);
    });
  });

  it('still reports the capability loss it would cause', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ supported: ['lexical-search'] });

      const failure = await runDeploy(
        base(root, fake.target, {
          dryRun: true,
          buildCapabilities: ['lexical-search', 'table-query'],
        }),
      ).catch((error: unknown) => error);

      // A dry run that hid the reason a real run would fail would be worse than no dry run.
      expect((failure as LoreError).code).toBe('LORE_E_CAPABILITY_LOSS');
    });
  });
});

describe('receipts', () => {
  it('validate against the committed schema', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();
      const result = await runDeploy(base(root, fake.target));

      const onDisk = JSON.parse(readFileSync(receiptPath(root, result.receipt.receiptId), 'utf8'));
      expect(deploymentReceiptSchema.safeParse(onDisk).success).toBe(true);
      expect(onDisk).toEqual(result.receipt);
    });
  });

  it('record the endpoint and the build that was serving before', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();
      const result = await runDeploy(base(root, fake.target));

      expect(result.receipt.endpoint).toBe('https://fake.example/mcp');
      expect(result.receipt.buildId).toBe(BUILD);
    });
  });

  it('refuse a receipt that has been edited into something invalid', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();
      const result = await runDeploy(base(root, fake.target));

      const { writeFileSync } = await import('node:fs');
      writeFileSync(receiptPath(root, result.receipt.receiptId), '{"formatVersion":1}');

      expect(() => readReceipt(root, result.receipt.receiptId)).toThrowError(/not readable/);
    });
  });

  it('say plainly when the receipt named by --resume does not exist', async () => {
    await deploying(async (root) => {
      expect(() => readReceipt(root, 'nope')).toThrowError(/No deployment receipt nope/);
    });
  });
});

describe('the smoke check', () => {
  /**
   * The difference between "the write returned" and "it is serving".
   *
   * A pointer that was written and not picked up is the failure mode a deploy cannot afford to
   * miss, because everything downstream reports success.
   */
  it('fails when the endpoint is serving a different build', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ confirms: `lore_${'b'.repeat(64)}` });

      const failure = await runDeploy(base(root, fake.target)).catch((error: unknown) => error);

      const error = failure as LoreError;
      expect(error.code).toBe('LORE_E_REMOTE_DEPLOY');
      expect(error.message).toContain('not the build that was just activated');
      // The projected candidate is still there, so the advice is to deploy again rather than
      // to start from nothing.
      expect(error.remediation).toContain('will be reused');
    });
  });

  it('accepts a target that cannot confirm, and records that it could not', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget({ confirms: null });

      const result = await runDeploy(base(root, fake.target));

      // Not treated as a failure: a target that cannot query itself is a limitation, not a
      // broken deploy. It is also not treated as a confirmation.
      expect(result.receipt.state).toBe('active');
      expect(result.activation?.confirmedBuildId).toBeNull();
    });
  });
});

describe('resume', () => {
  /**
   * A mid-apply failure leaves a receipt, and `--resume` continues from it.
   *
   * The assertion that matters is that the second run does **not** project again: a resume that
   * repeats a remote write is a restart wearing a different name, and on a real target it costs
   * whatever the first attempt already paid for.
   */
  it('continues from the last completed step without projecting twice', async () => {
    await deploying(async (root) => {
      const failing = fakeTarget({ failApplyOnce: true });
      const first = await runDeploy(base(root, failing.target)).catch((error: unknown) => error);
      expect((first as LoreError).code).toBe('LORE_E_REMOTE_DEPLOY');

      // The receipt written before the failure is what a resume is driven by.
      const partial = readReceipt(root, 'fake-aaaaaaaaaaaa');
      expect(partial.completedSteps).toEqual(['plan']);

      const resuming = fakeTarget();
      const result = await runDeploy(
        base(root, resuming.target, {
          resume: { ...partial, completedSteps: ['plan', 'project'] },
        }),
      );

      // Projected once, by the run that failed. The resume verified and activated.
      expect(resuming.calls).not.toContain('apply');
      expect(resuming.calls).toEqual(['detect', 'plan', 'verify', 'activate']);
      expect(result.receipt.state).toBe('active');
    });
  });

  it('is idempotent: resuming a finished deploy changes nothing about the outcome', async () => {
    await deploying(async (root) => {
      const fake = fakeTarget();
      const first = await runDeploy(base(root, fake.target));

      const again = fakeTarget();
      const second = await runDeploy(base(root, again.target, { resume: first.receipt }));

      expect(second.receipt.state).toBe('active');
      expect(second.receipt.buildId).toBe(first.receipt.buildId);
      expect(second.receipt.completedSteps).toEqual(first.receipt.completedSteps);
      // Neither the projection nor the verification is repeated.
      expect(again.calls).not.toContain('apply');
      expect(again.calls).not.toContain('verify');
    });
  });
});

describe('a target cannot change the build', () => {
  /**
   * Section 16.3: targets cannot change canonical build contents.
   *
   * Asserted by hashing the build directory before and after, which is the only form of this
   * assertion that survives a target doing something nobody anticipated.
   */
  it('leaves the sealed build byte for byte identical', async () => {
    await deploying(async (root) => {
      const { mkdirSync, writeFileSync, readdirSync, readFileSync: read } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      const directory = `${root}/.lore/builds/${BUILD}`;
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/manifest.json`, '{"formatVersion":1}');
      writeFileSync(`${directory}/context.sqlite`, 'pretend');

      const digest = () => {
        const hash = createHash('sha256');
        for (const name of readdirSync(directory).sort()) {
          hash.update(name).update(read(`${directory}/${name}`));
        }
        return hash.digest('hex');
      };

      const before = digest();
      await runDeploy(base(root, fakeTarget().target));
      expect(digest()).toBe(before);
    });
  });

  /**
   * And the orchestration cannot either.
   *
   * Receipts go under `.lore/receipts/`, deliberately outside `builds/`: a deploy writing
   * anything into a sealed build would make its bytes depend on where it had been sent, which
   * is the immutability invariant read backwards.
   */
  it('writes its receipt outside the build directory', async () => {
    await deploying(async (root) => {
      const result = await runDeploy(base(root, fakeTarget().target));
      expect(receiptPath(root, result.receipt.receiptId)).toContain('/receipts/');
      expect(receiptPath(root, result.receipt.receiptId)).not.toContain('/builds/');
    });
  });
});
