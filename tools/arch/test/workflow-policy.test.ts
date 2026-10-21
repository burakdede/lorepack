import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
interface Step {
  name?: string;
  run?: string;
  if?: boolean | string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean | string;
}
interface Job {
  steps: Step[];
  if?: boolean | string;
  'continue-on-error'?: boolean | string;
  env?: Record<string, string>;
}
interface Workflow {
  jobs: Record<string, Job>;
}
const { parse, stringify } = createRequire(join(REPO_ROOT, 'packages/cli/package.json'))(
  'yaml',
) as {
  parse: (text: string) => Workflow;
  stringify: (value: unknown) => string;
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lore-workflow-policy-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(
    join(REPO_ROOT, 'scripts/check-verify-parity.mjs'),
    join(root, 'scripts/check-verify-parity.mjs'),
  );
  symlinkSync(join(REPO_ROOT, 'packages'), join(root, 'packages'), 'junction');
  for (const path of [
    '.github/workflows',
    '.changeset/config.json',
    'docs/architecture/release-supply-chain.md',
    'docs/release-checklist.md',
    'docs/getting-started.md',
    'docs/compatibility/v0.1-upgrade.md',
    'README.md',
    'package.json',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it('runs the failed Windows observer cases in the diagnostic workflow', () => {
  const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/benchmarks.yml'), 'utf8'));
  const diagnostic = workflow.jobs['windows-observer'];
  expect(diagnostic.if).toContain("qualification == 'windows-observer'");
  expect(diagnostic.env?.LOREPACK_OBSERVER_DIAGNOSTIC).toBe('1');
  expect(diagnostic.steps.some((step) => step.run?.includes('cli-observer-cases.raw.log'))).toBe(
    true,
  );
  const step = diagnostic.steps.find((entry) => entry.name?.includes('failing CLI observer cases'));
  expect(step?.run).toContain('packages/cli/test/background_build.test.ts');
  expect(step?.run).toContain('packages/cli/test/resident_memory.e2e.test.ts');
  expect(step?.run).toContain('cli-observer-cases.exit.txt');
});

function mutate(name: string, change: (workflow: Workflow) => void): void {
  const path = join(root, '.github/workflows', name);
  const workflow = parse(readFileSync(path, 'utf8'));
  change(workflow);
  writeFileSync(path, stringify(workflow));
}

function run(name: string) {
  const scriptRoot = name === 'check-verify-parity.mjs' ? root : REPO_ROOT;
  return spawnSync(process.execPath, [join(scriptRoot, 'scripts', name)], {
    cwd: root,
    env: { ...process.env, LOREPACK_ROOT: root },
    encoding: 'utf8',
  });
}

function job(workflow: Workflow, id: string): Job {
  const value = workflow.jobs[id];
  if (value === undefined) throw new Error(`${id} job fixture missing`);
  return value;
}

function script(step: Step): string {
  if (step.run === undefined) throw new Error('run script fixture missing');
  return step.run;
}

function gate(workflow: Workflow): Step {
  const step = workflow.jobs.build?.steps.find((entry) =>
    entry.name?.startsWith('Verify required release gates'),
  );
  if (step === undefined) throw new Error('release gate fixture missing');
  return step;
}

function security(workflow: Workflow): Step {
  const step = workflow.jobs.verify?.steps.find((entry) => entry.run === 'pnpm test:security');
  if (step === undefined) throw new Error('security gate fixture missing');
  return step;
}

describe('structural release policy, issue618', () => {
  it('accepts equivalent parsed YAML formatting', () => {
    mutate('release.yml', () => {});
    const result = run('check-release-policy.mjs');
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects the reported commented gate and custom publish token', () => {
    let commented = '';
    mutate('release.yml', (workflow) => {
      const required = gate(workflow);
      commented = stringify(required)
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n');
      job(workflow, 'build').steps = job(workflow, 'build').steps.filter(
        (step) => step !== required,
      );
      job(workflow, 'publish').steps.push({
        run: 'npm config set //registry.npmjs.org/:_authToken "$PUBLISH_CREDENTIAL"',
        env: { PUBLISH_CREDENTIAL: '$' + '{{ secrets.NPM_PUBLISH }}' },
      });
    });
    const path = join(root, '.github/workflows/release.yml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${commented}\n`);
    const result = run('check-release-policy.mjs');
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('required release gate step');
    expect(result.stderr).toContain('publish credentials');
  });

  it.each(['conditional', 'optional', 'comment-only', 'commented-name'])(
    'rejects a %s release gate',
    (variant) => {
      mutate('release.yml', (workflow) => {
        const step = gate(workflow);
        if (variant === 'conditional') step.if = false;
        if (variant === 'optional') step['continue-on-error'] = true;
        if (variant === 'comment-only') {
          step.run = script(step)
            .split('\n')
            .map((line) => `# ${line}`)
            .join('\n');
        }
        if (variant === 'commented-name') {
          step.run = script(step).replace(
            '"verify (windows-latest)"',
            '# "verify (windows-latest)"',
          );
        }
      });
      const result = run('check-release-policy.mjs');
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain('required release gate');
    },
  );

  it.each(['secret-env', 'npmrc', 'token-config'])(
    'rejects %s publication credentials',
    (variant) => {
      mutate('release.yml', (workflow) => {
        const step: Step = { run: 'echo publishing' };
        if (variant === 'secret-env') step.env = { PUBLISH_KEY: '$' + '{{ secrets.CUSTOM_KEY }}' };
        if (variant === 'npmrc') step.run = 'printf "credential" > ~/.npmrc';
        if (variant === 'token-config')
          step.run = 'npm config set //registry.npmjs.org/:_authToken "$KEY"';
        job(workflow, 'publish').steps.push(step);
      });
      const result = run('check-release-policy.mjs');
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain('publish credentials');
    },
  );
});

describe('structural verify parity, issue618', () => {
  it.each(['typecheck:audit', 'coverage:inventory'])('rejects an omitted %s CI step', (command) => {
    mutate('ci.yml', (workflow) => {
      const steps = job(workflow, 'verify').steps;
      const index = steps.findIndex((step) => step.run === `pnpm ${command}`);
      if (index < 0) throw new Error(`${command} CI fixture missing`);
      steps.splice(index, 1);
    });
    const result = run('check-verify-parity.mjs');
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(`${command} is in`);
  });

  it('accepts an unconditional block scalar containing the exact command', () => {
    mutate('ci.yml', (workflow) => {
      security(workflow).run = 'pnpm test:security\n';
    });
    const result = run('check-verify-parity.mjs');
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    'or-true',
    'optional',
    'conditional',
    'job-conditional',
    'job-optional',
    'extra-command',
  ])('rejects the %s CI bypass', (variant) => {
    mutate('ci.yml', (workflow) => {
      const step = security(workflow);
      if (variant === 'or-true') step.run += ' || true';
      if (variant === 'optional') step['continue-on-error'] = true;
      if (variant === 'conditional') step.if = false;
      if (variant === 'job-conditional') job(workflow, 'verify').if = false;
      if (variant === 'job-optional') job(workflow, 'verify')['continue-on-error'] = true;
      if (variant === 'extra-command') step.run += '\necho passed';
    });
    const result = run('check-verify-parity.mjs');
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('test:security');
  });
});
