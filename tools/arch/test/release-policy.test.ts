import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkContributorAudit,
  reportsMatch,
  sbomsMatch,
} from '../../../scripts/check-supply-chain.mjs';
import {
  discoverPublishablePackages,
  findMissingPackages,
  packageExists,
} from '../../../scripts/release-packages.mjs';

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

  it('ignores a Changeset deleted by a generated release commit', () => {
    const changeset = "---\n'@lorepack/cli': patch\n---\n\nRelease automation.\n";
    const addSubject = 'Add release changeset';
    const releaseSubject = 'Release v0.1.0-alpha.0 [no release]';
    const history = [
      'reset refs/remotes/origin/main',
      'from refs/heads/main',
      '',
      'commit refs/heads/release',
      'mark :1',
      'committer Test User <test@example.com> 1700000000 +0000',
      `data ${Buffer.byteLength(addSubject)}`,
      addSubject,
      'from refs/heads/main',
      'M 100644 inline .changeset/release.md',
      `data ${Buffer.byteLength(changeset)}`,
      changeset,
      'commit refs/heads/release',
      'mark :2',
      'committer Test User <test@example.com> 1700000001 +0000',
      `data ${Buffer.byteLength(releaseSubject)}`,
      releaseSubject,
      'from :1',
      'D .changeset/release.md',
      '',
      'reset refs/remotes/origin/pr-100',
      'from :2',
      '',
    ].join('\n');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: history });
    const imported = execFileSync(
      'git',
      ['log', '--reverse', '--format=%s', '--name-status', 'origin/main..origin/pr-100'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(imported.split(/\r?\n/).filter(Boolean)).toEqual([
      addSubject,
      'A\t.changeset/release.md',
      releaseSubject,
      'D\t.changeset/release.md',
    ]);

    const result = run(CHANGESET_CHECK, root, { CHANGESET_HEAD_REF: 'origin/pr-100' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects a change with neither changeset nor marker', () => {
    writeFileSync(join(root, 'docs.md'), 'Documentation only.\n');

    const result = run(CHANGESET_CHECK, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pull requests need a changeset');
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])('evaluates a long PR graph with marker %s and pruning %s', (hasMarker, prune) => {
    const base = 'refs/heads/main';
    let history = '';
    for (let index = 1; index <= 70; index++) {
      const subject =
        index === 1 && hasMarker ? 'Document policy [no release]' : `Advance ${index}`;
      const content = `${index}\n`;
      history += `commit refs/heads/feature\nmark :${index}\ncommitter Test User <test@example.com> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nfrom ${index === 1 ? base : `:${index - 1}`}\nM 100644 inline docs.md\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: history });
    const eventHead = execFileSync('git', ['rev-parse', 'refs/heads/feature'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(
      execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/pull/'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const verify = workflow.slice(
      workflow.indexOf('\n  verify:'),
      workflow.indexOf('\n  acceptance:'),
    );
    const checkoutStep = verify.slice(0, verify.indexOf('- uses: pnpm/action-setup'));
    const depth = Number(/fetch-depth:\s*(\d+)/.exec(checkoutStep)?.[1] ?? '1');
    const checkout = join(root, 'checkout');
    execFileSync(
      'git',
      [
        'clone',
        '--config',
        `fetch.prune=${String(prune)}`,
        '--no-local',
        '--branch',
        'feature',
        ...(depth === 0 ? [] : [`--depth=${depth}`]),
        root,
        checkout,
      ],
      { stdio: 'pipe' },
    );
    expect(readFileSync(join(checkout, '.git', 'config'), 'utf8')).toMatch(
      new RegExp(`\\[fetch\\]\\s+prune = ${String(prune)}`),
    );
    const expand = (value: string) =>
      value
        .replaceAll(/\$\{\{\s*github\.base_ref\s*\}\}/g, 'main')
        .replaceAll(/\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/g, eventHead)
        .replaceAll(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, '718');
    const fetches = [...verify.matchAll(/git fetch ([^\n]+)/g)];
    expect(fetches).toHaveLength(1);
    for (const [, command] of fetches) {
      const args = expand(command).match(/"[^"]*"|\S+/g);
      if (!args) throw new Error('Missing workflow fetch arguments.');
      execFileSync('git', ['fetch', ...args.map((value) => value.replace(/^"|"$/g, ''))], {
        cwd: checkout,
        stdio: 'pipe',
      });
    }
    const head = /export CHANGESET_HEAD_REF="([^"]+)"/.exec(verify)?.[1];
    if (!head) throw new Error('Missing workflow PR head selection.');
    const result = run(CHANGESET_CHECK, checkout, {
      GITHUB_BASE_REF: 'main',
      CHANGESET_HEAD_REF: expand(head),
    });
    expect(result.status, result.stderr || result.stdout).toBe(hasMarker ? 0 : 1);
    if (!hasMarker) expect(result.stderr).toContain('pull requests need a changeset');
  });
});

describe('release policy', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lore-release-policy-'));
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.changeset'), { recursive: true });
    mkdirSync(join(root, 'docs', 'architecture'), { recursive: true });
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ fixed: [] }));
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
    writeFileSync(join(root, 'README.md'), 'npm install -g @lorepack/cli@next\n');
    writeFileSync(join(root, 'docs', 'getting-started.md'), 'npm install -g @lorepack/cli@next\n');
    writeFileSync(
      join(root, '.github', 'workflows', 'public-registry-smoke.yml'),
      publicRegistryWorkflow(),
    );
    for (const name of ['ci.yml', 'commit-hygiene.yml']) {
      writeFileSync(
        join(root, '.github', 'workflows', name),
        readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8'),
      );
    }
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

  it('requires an idempotent recovery path for an already-merged release', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('resume_existing:');
    expect(workflow).toContain('Require the release commit to carry the requested version');
    // A retry reuses a tag only when it already names this commit; a tag is never moved (#619).
    expect(workflow).toContain('existing $release_tag targets');
    expect(workflow).not.toContain('gh release edit');
    expect(workflow).toContain('gh release upload "$release_tag"');
    expect(workflow).toContain('scripts/publish-packages.mjs --tag');
    expect(workflow).toContain('Require npm Trusted Publishing for real release');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('requires an npm package bootstrap preflight before release side effects', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const preflight = workflow.indexOf('Preflight npm package bootstrap');
    const release = workflow.indexOf('Create GitHub release with SBOM and example artifact');
    const publish = workflow.indexOf('Publish npm packages with Trusted Publishing');

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(release);
    expect(preflight).toBeLessThan(publish);
    expect(workflow).toContain('scripts/preflight-npm-packages.mjs');
  });
});

describe('npm package preflight', () => {
  const packageJson = (name: string) => ({ directory: '/tmp/package', name });

  it('discovers only the public CLI package', () => {
    expect(discoverPublishablePackages().map(({ name }) => name)).toEqual(['@lorepack/cli']);
  });

  it('accepts packages that exist in the registry', () => {
    expect(packageExists(packageJson('@lorepack/cli'), () => ({ status: 0 }))).toBe(true);
  });

  it('reports only packages missing from the registry', () => {
    const missing = findMissingPackages(
      [packageJson('@lorepack/cli'), packageJson('@lorepack/core')],
      ([, name]) =>
        name === '@lorepack/cli'
          ? { status: 0 }
          : { status: 1, stdout: '', stderr: 'npm error code E404' },
    );

    expect(missing.map(({ name }) => name)).toEqual(['@lorepack/core']);
  });

  it('fails closed for registry errors that are not missing packages', () => {
    expect(() =>
      packageExists(packageJson('@lorepack/cli'), () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code E401',
      })),
    ).toThrow('npm view failed for @lorepack/cli');
  });
});

describe('performance report policy', () => {
  it('accepts the checked-in v0.1 performance report', () => {
    expect(run(PERFORMANCE_CHECK, REPO_ROOT).status).toBe(0);
  });
});

describe('contributor dependency audit', () => {
  let root: string;
  let packageManager: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lore audit-'));
    packageManager = join(root, 'package-manager.cjs');
    vi.stubEnv('npm_execpath', packageManager);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('audits development dependencies and accepts an exit below the High threshold', () => {
    writeFileSync(
      packageManager,
      `const expected = ['audit', '--audit-level', 'high'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(3);
process.stdout.write('2 Moderate findings');
`,
    );
    const problems: string[] = [];
    checkContributorAudit(problems);
    expect(problems).toEqual([]);
  });

  it.each([
    { message: '1 High finding', stream: 'stdout' },
    { message: 'registry request failed', stream: 'stderr' },
  ])('fails closed when the package manager reports $message', ({ message, stream }) => {
    writeFileSync(
      packageManager,
      `process.${stream}.write(${JSON.stringify(message)}); process.exitCode = 1;`,
    );
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
    const problems: string[] = [];
    checkContributorAudit(problems);
    expect(problems).toEqual(['contributor audit failed; run pnpm audit --audit-level high']);
    expect(diagnostics).toHaveBeenCalledWith(message);
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

  it('ignores registry publish dates that can vary by registry replica', () => {
    const report = dependencyReport();
    const replicaSnapshot = {
      ...report,
      dependencies: [
        {
          ...report.dependencies[0],
          pinnedPublishedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    };

    expect(reportsMatch(replicaSnapshot, report)).toBe(true);
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

  it('ignores object key order in report and SBOM snapshots', () => {
    const report = {
      ...dependencyReport(),
      audit: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    };
    const reorderedReport = {
      ...report,
      audit: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
    };
    const sbom = {
      components: [{ licenses: [{ expression: 'MIT' }], name: 'example' }],
      metadata: { component: { name: 'lorepack' } },
    };
    const reorderedSbom = {
      metadata: { component: { name: 'lorepack' } },
      components: [{ name: 'example', licenses: [{ expression: 'MIT' }] }],
    };

    expect(reportsMatch(reorderedReport, report)).toBe(true);
    expect(sbomsMatch(sbom, reorderedSbom)).toBe(true);
  });

  it('ignores dependency and SBOM component order', () => {
    const report = dependencyReport();
    const reorderedReport = {
      ...report,
      dependencies: [...report.dependencies].reverse(),
    };
    const sbom = {
      components: [
        { name: 'z-package', licenses: [{ expression: 'MIT' }] },
        { name: 'a-package', licenses: [{ expression: 'MIT' }] },
      ],
      metadata: { component: { name: 'lorepack' } },
    };
    const reorderedSbom = {
      ...sbom,
      components: [...sbom.components].reverse(),
    };

    expect(reportsMatch(reorderedReport, report)).toBe(true);
    expect(sbomsMatch(sbom, reorderedSbom)).toBe(true);
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

/**
 * The checked-in release workflow. The policy now parses it (#604), so a fixture built from
 * a list of required phrases is no longer a workflow the check could accept.
 */
function releaseWorkflow(): string {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
}

function publicRegistryWorkflow(): string {
  return [
    'release:',
    'types: [published]',
    'workflow_dispatch:',
    'ubuntu-latest',
    'windows-latest',
    'macos-latest',
    'npm view',
    'seq 1 30',
    'sleep 10',
    'npm install --global --ignore-scripts',
    'npm audit signatures',
    'scripts/check-registry-provenance.mjs',
    'scripts/public-registry-smoke.mjs',
    'GITHUB_STEP_SUMMARY',
  ].join('\n');
}
