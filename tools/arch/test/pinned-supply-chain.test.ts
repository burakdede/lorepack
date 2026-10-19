import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditJson,
  checkContributorAudit,
  checkDocs,
  healthReport,
  licenseInventory,
  reportsMatch,
} from '../../../scripts/check-supply-chain.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const auditCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
let auditOutput: string;
let licenseOutput: string;
let pinnedProvenance: boolean;
let latestProvenance: boolean;
const registryOverrides = new Map<string, unknown>();
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  vi.stubEnv('npm_execpath', 'fixture.cjs');
  auditOutput = JSON.stringify({ metadata: { vulnerabilities: auditCounts } });
  licenseOutput = JSON.stringify({
    MIT: [{ name: 'fixture', versions: ['1.0.0'], paths: ['/installed/fixture'] }],
  });
  registryOverrides.clear();
  pinnedProvenance = false;
  latestProvenance = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:34:56.000Z'));
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    const command = [...(args ?? [])].filter((argument) => !argument.endsWith('.cjs'));
    if (command[0] === 'audit') return auditOutput;
    if (command[0] === 'licenses') return licenseOutput;
    if (command[0] !== 'view') throw new Error(`unexpected command ${command.join(' ')}`);
    const specifier = command[1] ?? '';
    if (registryOverrides.has(specifier)) return JSON.stringify(registryOverrides.get(specifier));
    const version = specifier.match(/@(\d+\.\d+\.\d+)$/)?.[1] ?? '99.0.0';
    const attested = version === '99.0.0' ? latestProvenance : pinnedProvenance;
    return JSON.stringify({
      version,
      license: 'MIT',
      time: { [version]: '2025-04-17T00:00:00.000Z' },
      dist: attested
        ? { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }
        : {},
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalPlatform !== undefined) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('pinned-version supply-chain evidence, issue623', () => {
  it('does not report a latest-version attestation as pinned provenance', () => {
    const report = healthReport();
    expect(
      report.dependencies.find((dependency) => dependency.name === 'react')?.provenance,
    ).toMatchObject({ status: 'missing' });
    expect(report.provenance.missing).toContain('react');
  });

  it('keeps a pinned attestation when the latest release has none', () => {
    pinnedProvenance = true;
    latestProvenance = false;
    const report = healthReport();
    expect(
      report.dependencies.find((dependency) => dependency.name === 'react')?.provenance,
    ).toMatchObject({ status: 'present', predicateType: 'https://slsa.dev/provenance/v1' });
  });

  it('advances maintenance age with wall-clock UTC time', () => {
    const first = healthReport();
    vi.setSystemTime(new Date('2026-10-19T12:34:56.000Z'));
    const second = healthReport();
    expect(second.dependencies[0]?.daysSinceLastRelease).toBe(
      (first.dependencies[0]?.daysSinceLastRelease ?? 0) + 1,
    );
    expect(first.dependencies[0]?.health.status).toBe('stale-warning');
    expect(reportsMatch(first, second)).toBe(true);
  });

  it('rejects a pinned registry response naming another version', () => {
    registryOverrides.set('react@19.2.0', { version: '99.0.0', license: 'MIT' });
    expect(() => healthReport()).toThrow();
  });

  it.each([null, [], {}, { version: '99.0.0', time: { '99.0.0': 'invalid' } }])(
    'rejects missing or malformed maintenance metadata: %j',
    (metadata) => {
      registryOverrides.set('react', metadata);
      expect(() => healthReport()).toThrow();
    },
  );

  it('makes changed pinned provenance fail report freshness', () => {
    const missing = healthReport();
    pinnedProvenance = true;
    const attested = healthReport();
    expect(reportsMatch(missing, attested)).toBe(false);
  });
});

describe.each(['darwin', 'linux', 'win32'])(
  'package-manager evidence must fail closed on %s, issue623',
  (platform) => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: platform });
      vi.stubEnv('npm_execpath', undefined);
    });
    it.each(['cjs', 'js', 'mjs'])(
      'runs a .%s package-manager entrypoint through Node without a shell',
      (extension) => {
        const entrypoint = `C:\\Program Files\\pnpm\\pnpm.${extension}`;
        vi.stubEnv('npm_execpath', entrypoint);
        vi.mocked(execFileSync).mockReturnValue(licenseOutput);
        licenseInventory();
        expect(execFileSync).toHaveBeenLastCalledWith(
          process.execPath,
          [entrypoint, 'licenses', 'list', '--prod', '--json'],
          expect.not.objectContaining({ shell: true }),
        );
      },
    );
    it.each([
      '',
      ' ',
      'null',
      '{}',
      '[]',
      '{"metadata":{"vulnerabilities":{}}}',
      '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":"0"}}}',
      '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":-1}}}',
    ])('rejects absent or invalid production audit evidence: %j', (output) => {
      auditOutput = output;
      expect(() => auditJson()).toThrow();
    });

    it.each([
      '',
      ' ',
      'null',
      '{}',
      '[]',
      '{"MIT":[]}',
      '{"MIT":[{}]}',
      '{"MIT":[{"name":"fixture","versions":[]}]}',
      '{"MIT":[{"name":"fixture","versions":["1.0.0"]}]}',
    ])('rejects absent or invalid installed license evidence: %j', (output) => {
      licenseOutput = output;
      expect(() => licenseInventory()).toThrow();
    });

    it('accepts explicit zero vulnerability counts and a nonempty installed package inventory', () => {
      expect(auditJson()).toEqual({ metadata: { vulnerabilities: auditCounts } });
      expect(licenseInventory()).toEqual({
        MIT: [{ name: 'fixture', versions: ['1.0.0'], paths: ['/installed/fixture'] }],
      });
    });

    it('rejects empty contributor audit output even when the command exits successfully', () => {
      auditOutput = '';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const problems: string[] = [];
      checkContributorAudit(problems);
      expect(problems).not.toEqual([]);
    });

    it('does not turn a failed audit command with zero counts into clean evidence', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw Object.assign(new Error('registry unavailable'), { status: 1, stdout: auditOutput });
      });
      expect(() => auditJson()).toThrow();
    });

    it('does not swallow a failed audit command merely because stdout parses', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw Object.assign(new Error('registry unavailable'), { status: 1, stdout: '{}' });
      });
      expect(() => auditJson()).toThrow();
    });
  },
);

describe('specific dependency policy decisions, issue623', () => {
  const dependency = {
    name: 'react',
    specifiers: ['19.2.0'],
    health: { status: 'current' },
    provenance: { status: 'missing' },
  };

  it('does not let a generic rationale waive missing pinned provenance', () => {
    const problems: string[] = [];
    checkDocs({ dependencies: [dependency] }, problems, {});
    expect(problems.some((problem) => problem.includes('missingProvenance'))).toBe(true);
  });

  it('does not let a generic rationale waive newly stale dependencies', () => {
    const problems: string[] = [];
    checkDocs(
      {
        dependencies: [
          {
            ...dependency,
            health: { status: 'stale-warning' },
            provenance: { status: 'present' },
          },
        ],
      },
      problems,
      {},
    );
    expect(problems.some((problem) => problem.includes('stale'))).toBe(true);
  });

  it('does not inherit a reviewed exception from another package version', () => {
    const problems: string[] = [];
    checkDocs({ dependencies: [dependency] }, problems, {
      missingProvenance: {
        'react@19.1.0': { owner: 'maintainer', reason: 'Reviewed previous pinned version.' },
      },
    });
    expect(problems.some((problem) => problem.includes('missingProvenance'))).toBe(true);
  });

  it.each([
    {},
    { owner: '', reason: 'Reviewed fixture decision.' },
    { owner: 'maintainer', reason: ' ' },
  ])('rejects incomplete version-specific decisions: %j', (decision) => {
    const problems: string[] = [];
    checkDocs({ dependencies: [dependency] }, problems, {
      missingProvenance: { 'react@19.2.0': decision },
    });
    expect(problems.some((problem) => problem.includes('missingProvenance'))).toBe(true);
  });

  it('accepts an explicit decision for this exact pinned package', () => {
    const problems: string[] = [];
    checkDocs({ dependencies: [dependency] }, problems, {
      missingProvenance: {
        'react@19.2.0': { owner: 'maintainer', reason: 'Reviewed fixture decision.' },
      },
    });
    expect(problems).toEqual([]);
  });
});
