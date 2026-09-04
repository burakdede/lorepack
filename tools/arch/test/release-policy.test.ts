import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportsMatch } from '../../../scripts/check-supply-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CHANGESET_CHECK = join(REPO_ROOT, 'scripts', 'check-changeset-policy.mjs');
const RELEASE_CHECK = join(REPO_ROOT, 'scripts', 'check-release-policy.mjs');
const PERFORMANCE_CHECK = join(REPO_ROOT, 'scripts', 'check-performance-report.mjs');

describe('changeset policy', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lore-changeset-'));
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeFileSync(join(root, '.changeset', 'config.json'), '{}\n');
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: root });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts an uncommitted changeset before the PR commit exists', () => {
    writeFileSync(
      join(root, '.changeset', 'release.md'),
      "---\n'@lorepack/cli': patch\n---\n\nRelease automation.\n",
    );

    const result = run(CHANGESET_CHECK, root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('accepts an explicit no-release marker', () => {
    writeFileSync(join(root, 'docs.md'), 'Documentation only.\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Document policy [no release]'], { cwd: root });

    const result = run(CHANGESET_CHECK, root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('accepts changesets with Windows line endings', () => {
    writeFileSync(
      join(root, '.changeset', 'release.md'),
      "---\r\n'@lorepack/cli': patch\r\n---\r\n\r\nRelease automation.\r\n",
    );

    const result = run(CHANGESET_CHECK, root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('ignores no-release text in synthetic merge commit messages', () => {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: root });
    writeFileSync(
      join(root, '.changeset', 'release.md'),
      "---\n'@lorepack/cli': patch\n---\n\nRelease automation.\n",
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Add release automation'], { cwd: root });
    const feature = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const tree = execFileSync('git', ['rev-parse', `${feature}^{tree}`], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', 'main'], { cwd: root });
    const main = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const merge = execFileSync(
      'git',
      ['commit-tree', tree, '-p', main, '-p', feature, '-m', 'Merge pull request [no release]'],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['checkout', merge], { cwd: root });

    const result = run(CHANGESET_CHECK, root);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('checks an explicit pull request head ref', () => {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: root });
    writeFileSync(
      join(root, '.changeset', 'release.md'),
      "---\n'@lorepack/cli': patch\n---\n\nRelease automation.\n",
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Add release automation'], { cwd: root });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/pr-100', 'HEAD'], { cwd: root });
    execFileSync('git', ['checkout', 'main'], { cwd: root });

    const result = run(CHANGESET_CHECK, root, { CHANGESET_HEAD_REF: 'origin/pr-100' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects a change with neither changeset nor marker', () => {
    writeFileSync(join(root, 'docs.md'), 'Documentation only.\n');

    const result = run(CHANGESET_CHECK, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pull requests need a changeset');
  });
});

describe('release policy', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lore-release-policy-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.changeset'), { recursive: true });
    mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
    writeFileSync(
      join(root, '.changeset', 'config.json'),
      JSON.stringify({ fixed: [['@lorepack/*']] }),
    );
    writeFileSync(
      join(root, 'docs', 'architecture', 'release-supply-chain.md'),
      [
        '## Versioning Policy',
        '`next`',
        '`formatVersion`',
        '`schemaVersion`',
        '## Release Checklist',
        '## Rollback and Deprecation',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'docs', 'release-checklist.md'),
      [
        'client trust prompts',
        'Cloudflare acceptance',
        'demo script',
        'dry-run',
        'performance report',
        'deprecate',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a release workflow that omits the performance gate', () => {
    writeFileSync(
      join(root, '.github', 'workflows', 'release.yml'),
      releaseWorkflow().replace('performance_report_url:', 'missing_report_url:'),
    );

    const result = run(RELEASE_CHECK, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('performance report');
  });

  it('accepts the checked-in release workflow shape', () => {
    writeFileSync(join(root, '.github', 'workflows', 'release.yml'), releaseWorkflow());

    expect(run(RELEASE_CHECK, root).status).toBe(0);
  });
});

describe('performance report policy', () => {
  it('accepts the checked-in v0.1 performance report', () => {
    expect(run(PERFORMANCE_CHECK, REPO_ROOT).status).toBe(0);
  });
});

describe('supply-chain report freshness', () => {
  it('ignores volatile registry observations but preserves the security contract', () => {
    const report = dependencyReport();
    const newerRegistrySnapshot = {
      ...report,
      dependencies: [
        {
          ...report.dependencies[0],
          latestVersion: '2.0.0',
          latestReleaseAt: '2026-09-04T00:00:00.000Z',
          provenance: {
            status: 'present',
            predicateType: 'https://slsa.dev/provenance/v1',
            url: 'https://registry.npmjs.org/attestations/example@2.0.0',
          },
        },
      ],
    };

    expect(reportsMatch(newerRegistrySnapshot, report)).toBe(true);
  });

  it('rejects a changed audit result or dependency inventory', () => {
    const report = dependencyReport();
    expect(
      reportsMatch(
        {
          ...report,
          audit: { vulnerabilities: { moderate: 1 } },
        },
        report,
      ),
    ).toBe(false);
    expect(
      reportsMatch(
        {
          ...report,
          dependencies: [{ ...report.dependencies[0], specifiers: ['2.0.0'] }],
        },
        report,
      ),
    ).toBe(false);
  });
});

function dependencyReport() {
  return {
    schemaVersion: 1,
    policyDate: '2026-08-20',
    staleAfterDays: 548,
    audit: { vulnerabilities: { moderate: 0 } },
    licenses: ['MIT'],
    provenance: { checked: 1, missing: [], notChecked: [] },
    dependencies: [
      {
        name: 'example',
        specifiers: ['1.0.0'],
        dependencyTypes: ['dependencies'],
        references: ['packages/example/package.json:dependencies'],
        pinnedPublishedAt: '2026-01-01T00:00:00.000Z',
        latestVersion: '1.0.0',
        latestReleaseAt: '2026-01-01T00:00:00.000Z',
        daysSinceLastRelease: 231,
        license: 'MIT',
        provenance: {
          status: 'present',
          predicateType: 'https://slsa.dev/provenance/v1',
          url: null,
        },
        health: { status: 'current' },
      },
    ],
  };
}

function run(script: string, root: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        CHANGESET_BASE_REF: 'origin/main',
        GITHUB_BASE_REF: '',
        LOREPACK_ROOT: root,
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      status: failed.status ?? 1,
      stdout: failed.stdout?.toString() ?? '',
      stderr: failed.stderr?.toString() ?? '',
    };
  }
}

function releaseWorkflow(): string {
  return [
    'workflow_dispatch:',
    'dry_run:',
    'channel:',
    'performance_report_url:',
    'pnpm changeset version',
    'pnpm changeset publish --tag',
    'NPM_TOKEN',
    'id-token: write',
    'check-runs',
    '$conclusion" != "success"',
    'gh release create',
    'examples/product-research/product-research.lorepack',
    'reports/sbom.cyclonedx.json',
    'stable publish requires the green issue #101 performance report URL',
    'pack --pack-destination',
    'Require npm publish token for real release',
    'Commit version and generated release artifacts',
    'Create GitHub release with SBOM and example artifact',
    'Publish npm packages with provenance',
    'verify (ubuntu-latest)',
    'verify (windows-latest)',
    'verify (macos-latest)',
    'acceptance (ubuntu-latest)',
    'acceptance (windows-latest)',
    'acceptance (macos-latest)',
    'clean install (ubuntu-latest)',
    'clean install (windows-latest)',
    'clean install (macos-latest)',
    'cloudflare acceptance (ubuntu-latest)',
    'studio e2e (ubuntu-latest)',
    'benchmarks (reported, not enforced)',
  ].join('\n');
}
