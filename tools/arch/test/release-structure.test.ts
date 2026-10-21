import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  releaseStructureProblems,
  topLevelPermissionProblems,
} from '../../../scripts/release-structure.mjs';

/**
 * The release workflow's job structure (#604, #619), checked on the parsed YAML.
 *
 * Each mutation below is one way the publish path has been, or could be, opened again: the
 * OIDC capability next to a dev-dependency install, a publish outside the protected
 * environment, a tag created before npm accepted the tarball.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const { parse, stringify } = createRequire(join(REPO_ROOT, 'packages', 'cli', 'package.json'))(
  'yaml',
) as {
  parse: (text: string) => Workflow;
  stringify: (value: unknown) => string;
};

interface Step {
  name?: string;
  env?: Record<string, string>;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  env?: Record<string, string>;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: {
    group: string;
    queue?: string;
    'cancel-in-progress': boolean;
  };
  steps?: Step[];
}
interface Workflow {
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  concurrency?: {
    group: string;
    queue?: string;
    'cancel-in-progress': boolean;
  };
  jobs: Record<string, Job>;
}

function workflow(name: string): string {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
}

function mutated(change: (release: Workflow) => void): string {
  const release = parse(workflow('release.yml'));
  change(release);
  return stringify(release);
}

describe('the checked-in release workflow', () => {
  it('has no structural problems', () => {
    expect(releaseStructureProblems(workflow('release.yml'))).toEqual([]);
  });

  it.each(['ci.yml', 'commit-hygiene.yml', 'release.yml'])(
    '%s grants only read access at the top level',
    (name) => {
      expect(topLevelPermissionProblems(name, workflow(name))).toEqual([]);
    },
  );

  it('requires credentials in the Cloudflare release qualification job', () => {
    const ci = parse(workflow('ci.yml'));
    expect(ci.jobs['cloudflare-acceptance']?.env?.LORE_CF_REQUIRED).toBe('1');
  });

  it('retains queued Cloudflare checks while serializing the shared runtime', () => {
    const ci = parse(workflow('ci.yml'));
    expect(ci.jobs['cloudflare-acceptance']?.concurrency).toEqual({
      group: 'cloudflare-acceptance',
      queue: 'max',
      'cancel-in-progress': false,
    });
  });

  it('runs the installed package smoke in the manual Windows observer qualification', () => {
    const benchmark = parse(workflow('benchmarks.yml'));
    const job = benchmark.jobs['windows-observer'];
    const d1 = job?.steps?.find((entry) =>
      entry.run?.includes('packages/deploy-cloudflare/test/query-budget.test.ts'),
    );
    const step = job?.steps?.find((entry) => entry.run?.includes('pnpm check:packed-cli'));
    expect(job?.env?.LOREPACK_OBSERVER_DIAGNOSTIC).toBe('1');
    expect(d1?.name).toBe('Run the D1 query-budget regression with observer diagnostics');
    expect(d1?.run).toContain("'d1-query-budget.raw.log'");
    expect(d1?.run).toContain("'d1-query-budget.exit.txt'");
    expect(step?.name).toBe('Run the packed install smoke with observer diagnostics');
    expect(step?.run).toContain("'packed-cli.raw.log'");
    expect(step?.run).toContain("'packed-cli.exit.txt'");
  });

  it('queues CI and benchmark runs together without replacing pending checks', () => {
    const policy = {
      group: 'lorepack-hosted-checks',
      queue: 'max',
      'cancel-in-progress': false,
    };
    expect(parse(workflow('ci.yml')).concurrency).toEqual(policy);
    expect(parse(workflow('benchmarks.yml')).concurrency).toEqual(policy);
  });
});

describe('the rules catch', () => {
  it('a second job that can mint the npm OIDC token', () => {
    const text = mutated((release) => {
      (release.jobs.build as Job).permissions = { contents: 'read', 'id-token': 'write' };
    });
    expect(releaseStructureProblems(text)).toEqual(
      expect.arrayContaining([
        'release.yml must grant id-token: write to exactly one job, not 2',
        'release.yml job build holds id-token: write and runs pnpm',
      ]),
    );
  });

  it('a workspace install in the publishing job', () => {
    const text = mutated((release) => {
      release.jobs.publish?.steps?.splice(1, 0, { run: 'pnpm install --frozen-lockfile' });
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job publish holds id-token: write and runs pnpm',
    );
  });

  it('publishing outside the protected environment', () => {
    const text = mutated((release) => {
      delete (release.jobs.publish as Job).environment;
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job publish must run in the npm-release environment',
    );
  });

  it('a full checkout in the publishing job', () => {
    const text = mutated((release) => {
      const checkout = release.jobs.publish?.steps?.find((step) =>
        step.uses?.startsWith('actions/checkout'),
      );
      if (checkout !== undefined) checkout.with = {};
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job publish may only check out a sparse tree without persisted credentials',
    );
  });

  it('a tag or GitHub release that does not wait for npm', () => {
    // #619: a failed publish must leave no tag behind, so tagging needs the publish job.
    const text = mutated((release) => {
      (release.jobs['github-release'] as Job).needs = 'build';
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job github-release tags or releases without needing the publish job',
    );
  });

  it('a job that skips the main-only guard', () => {
    const text = mutated((release) => {
      (release.jobs.build as Job).needs = [];
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job build does not depend on the guard job',
    );
  });

  it('an input pasted into a shell script', () => {
    const text = mutated((release) => {
      // Concatenated so the test source is not itself an interpolation the linter flags.
      release.jobs.guard?.steps?.push({ run: 'echo $' + '{{ inputs.version }}' });
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml job guard interpolates an input into a run script',
    );
  });

  it('write access granted to every job by default', () => {
    const text = mutated((release) => {
      release.permissions = { contents: 'write' };
    });
    expect(releaseStructureProblems(text)).toContain(
      'release.yml must declare a read-only top-level permissions block',
    );
    expect(topLevelPermissionProblems('ci.yml', 'on: push\njobs: {}\n')).toEqual([
      'ci.yml must declare a read-only top-level permissions block',
    ]);
  });
});

describe('the benchmark observer diagnostic', () => {
  it('opts in only the Windows measurement step without changing its commands', () => {
    const benchmark = parse(workflow('benchmarks.yml'));
    const job = benchmark.jobs.benchmark;
    const step = job?.steps?.find((entry) =>
      entry.run?.includes('node scripts/bench-retrieval-comparison.mjs'),
    );
    expect(step).toBeDefined();
    expect(step?.env?.LOREPACK_OBSERVER_DIAGNOSTIC).toBe(
      '$' + "{{ runner.os == 'Windows' && '1' || '0' }}",
    );
    expect(benchmark.env?.LOREPACK_OBSERVER_DIAGNOSTIC).toBeUndefined();
    expect(job?.env?.LOREPACK_OBSERVER_DIAGNOSTIC).toBeUndefined();
    expect(job?.steps?.filter((entry) => entry.env?.LOREPACK_OBSERVER_DIAGNOSTIC)).toEqual([step]);
    const runnerOs = '$' + '{RUNNER_OS}';
    expect(step?.run?.trim().split('\n')).toEqual([
      'set -euo pipefail',
      'mkdir -p benchmark-artifacts',
      `node scripts/bench-retrieval-comparison.mjs --out "benchmark-artifacts/comparison-${runnerOs}.json"`,
      `node scripts/bench-rag.mjs --out "benchmark-artifacts/rag-${runnerOs}.json"`,
      `node scripts/bench-usefulness.mjs --out "benchmark-artifacts/usefulness-${runnerOs}.json"`,
      `node scripts/research-safe-pruning.mjs --out "benchmark-artifacts/pruning-${runnerOs}.json"`,
    ]);
  });
});
