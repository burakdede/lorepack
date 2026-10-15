import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  command: vi.fn<(command: string, args: readonly string[], options: unknown) => string>(),
  write: vi.fn<(path: string, contents: string) => void>(),
  missing: new Set<string>(),
  files: new Map<string, string>(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: boundary.command,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: boundary.write,
    existsSync: (path: import('node:fs').PathLike) =>
      !boundary.missing.has(String(path)) && actual.existsSync(path),
    readFileSync: (
      path: import('node:fs').PathOrFileDescriptor,
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => boundary.files.get(String(path)) ?? actual.readFileSync(path, options),
  };
});

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts/check-supply-chain.mjs');
const REPORT = join(ROOT, 'reports/dependency-health.json');
const SBOM = join(ROOT, 'reports/sbom.cyclonedx.json');
const originalReport = readFileSync(REPORT, 'utf8');
const originalSbom = readFileSync(SBOM, 'utf8');
const snapshot = JSON.parse(originalReport) as {
  licenses: string[];
  audit: { vulnerabilities: Record<string, number> };
  dependencies: {
    name: string;
    specifiers: string[];
    latestVersion: string;
    latestReleaseAt: string;
    license: string;
    provenance: { status: string; predicateType?: string; url?: string };
  }[];
};

interface RegistryView {
  version?: string;
  time?: Record<string, string>;
  license?: string;
  dist?: { attestations: { provenance: { predicateType: string }; url?: string } };
}

const views = new Map<string, RegistryView | RegistryView[]>();
const writes = new Map<string, string>();
let audit: Record<string, number>;
let auditFailure: { stdout: string } | null;
let licenseOutput: string;
let contributorFailure: Error | null;
let argv: string[];

beforeEach(() => {
  argv = process.argv;
  process.argv = [process.execPath, SCRIPT];
  vi.stubEnv('npm_execpath', 'fixture-package-manager.cjs');
  vi.stubEnv(
    'LOREPACK_VERSION',
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  views.clear();
  writes.clear();
  boundary.missing.clear();
  boundary.files.clear();
  audit = { ...snapshot.audit.vulnerabilities };
  auditFailure = null;
  contributorFailure = null;
  licenseOutput = JSON.stringify(
    Object.fromEntries(
      snapshot.licenses.map((license) => [
        license,
        snapshot.dependencies
          .filter((item) => item.license === license)
          .map((item) => ({ name: item.name })),
      ]),
    ),
  );
  for (const dependency of snapshot.dependencies) {
    const time = Object.fromEntries(
      [...dependency.specifiers, dependency.latestVersion].map((version) => [
        version,
        dependency.latestReleaseAt,
      ]),
    );
    const view: RegistryView = {
      version: dependency.latestVersion,
      time,
      license: dependency.license,
    };
    if (dependency.provenance.status === 'present') {
      view.dist = {
        attestations: {
          provenance: {
            predicateType: dependency.provenance.predicateType ?? 'https://slsa.dev/provenance/v1',
          },
        },
      };
    }
    views.set(dependency.name, view);
    for (const specifier of dependency.specifiers)
      views.set(`${dependency.name}@${specifier}`, view);
  }
  boundary.write.mockImplementation((path, contents) => {
    writes.set(path, contents);
  });
  boundary.command.mockImplementation((command, args) => {
    const values = command === process.execPath ? args.slice(1) : args;
    if (values[0] === 'view') {
      expect(values.slice(2)).toEqual(['version', 'time', 'license', 'dist', '--json']);
      const view = views.get(values[1] ?? '');
      if (view === undefined) throw new Error(`Unexpected registry query: ${values[1]}`);
      return JSON.stringify(view);
    }
    if (values[0] === 'licenses') {
      expect(values).toEqual(['licenses', 'list', '--prod', '--json']);
      return licenseOutput;
    }
    if (values.includes('--prod')) {
      expect(values).toEqual(['audit', '--prod', '--audit-level', 'moderate', '--json']);
      if (auditFailure !== null) throw auditFailure;
      return JSON.stringify({ metadata: { vulnerabilities: audit } });
    }
    expect(values).toEqual(['audit', '--audit-level', 'high']);
    if (contributorFailure !== null) throw contributorFailure;
    return '';
  });
});

afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  boundary.command.mockReset();
  boundary.write.mockReset();
  boundary.missing.clear();
  boundary.files.clear();
  vi.resetModules();
  expect(readFileSync(REPORT, 'utf8')).toBe(originalReport);
  expect(readFileSync(SBOM, 'utf8')).toBe(originalSbom);
});

async function command(...flags: string[]) {
  process.argv = [process.execPath, SCRIPT, ...flags];
  await import('../../../scripts/check-supply-chain.mjs');
}

describe('supply-chain command policy with explicit registry fixtures', () => {
  it.each([
    { name: 'JavaScript entry', executable: 'fixture-package-manager.js' },
    { name: 'native executable', executable: 'fixture-package-manager' },
    { name: 'PATH fallback', executable: undefined },
  ])(
    'supports the package-manager $name without changing audit arguments',
    async ({ executable }) => {
      vi.stubEnv('npm_execpath', executable);
      vi.stubEnv('LOREPACK_VERSION', undefined);
      await command();
      const calls = boundary.command.mock.calls;
      expect(calls.some(([, args]) => args.includes('--prod') && args.includes('moderate'))).toBe(
        true,
      );
      expect(calls.some(([, args]) => args.includes('high'))).toBe(true);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('production audit clean'));
    },
  );

  it('reports a production range as provenance not checked rather than attested', async () => {
    const path = join(ROOT, 'packages/cli/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const pinned = manifest.dependencies.commander as string;
    boundary.files.set(
      path,
      JSON.stringify({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          commander: `^${pinned}`,
        },
      }),
    );
    await command('--write');
    const text = writes.get(REPORT);
    if (text === undefined) throw new Error('Expected report output.');
    const report = JSON.parse(text);
    expect(report.provenance.notChecked).toContain('commander');
    expect(
      report.dependencies.find((item: { name: string }) => item.name === 'commander'),
    ).toMatchObject({
      specifiers: [`^${pinned}`],
      provenance: { status: 'not-checked' },
    });
  });

  it('does not invent manifests for an absent optional workspace directory', async () => {
    boundary.missing.add(join(ROOT, 'apps'));
    await command('--write');
    const text = writes.get(REPORT);
    if (text === undefined) throw new Error('Expected report output.');
    const report = JSON.parse(text) as { dependencies: { references: string[] }[] };
    expect(
      report.dependencies.every((item) =>
        item.references.every((path) => !path.startsWith('apps/')),
      ),
    ).toBe(true);
  });

  it('rejects inconsistent installed licenses when the registry omits its license', async () => {
    const licenses = JSON.parse(licenseOutput);
    licenses.MIT.push({ name: 'commander' });
    licenses['BSD-3-Clause'].push({ name: 'commander' });
    licenseOutput = JSON.stringify(licenses);
    for (const [name, view] of views) {
      if (name !== 'commander' && !name.startsWith('commander@')) continue;
      if (Array.isArray(view)) throw new Error('Expected unwrapped registry fixture.');
      const { license: _license, ...metadata } = view;
      views.set(name, metadata);
    }
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith('  commander: license mixed is not allowlisted');
  });

  it('rejects missing committed report artifacts with repair instructions', async () => {
    boundary.missing.add(REPORT);
    boundary.missing.add(SBOM);
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith(
      '  reports/dependency-health.json is missing; run pnpm supply-chain:report',
    );
    expect(console.error).toHaveBeenCalledWith(
      '  reports/sbom.cyclonedx.json is missing; run pnpm supply-chain:report',
    );
    expect(writes.size).toBe(0);
  });

  it('rejects a publishable package without public access and provenance', async () => {
    const path = join(ROOT, 'packages/cli/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    boundary.files.set(
      path,
      JSON.stringify({
        ...manifest,
        private: false,
        publishConfig: { access: 'restricted', provenance: false },
      }),
    );
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith(
      '  packages/cli/package.json: publishConfig.provenance must be true',
    );
    expect(console.error).toHaveBeenCalledWith(
      '  packages/cli/package.json: publishConfig.access must be public',
    );
  });

  it('requires documented decisions for stale and unattested dependencies', async () => {
    const dependency = snapshot.dependencies.find((item) => item.name === 'commander');
    if (dependency === undefined) throw new Error('Expected committed production dependency.');
    const view = views.get(dependency.name);
    if (view === undefined || Array.isArray(view)) throw new Error('Expected registry fixture.');
    const old = { ...view, time: { [dependency.latestVersion]: '2000-01-01T00:00:00.000Z' } };
    views.set(dependency.name, old);
    boundary.files.set(
      join(ROOT, 'docs/architecture/dependencies.md'),
      '# No recorded decisions\n',
    );
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith(
      '  docs/architecture/dependencies.md has no rationale for commander',
    );
    expect(console.error).toHaveBeenCalledWith(
      '  stale dependency commander has no recorded decision',
    );
    expect(console.error).toHaveBeenCalledWith(
      '  dependency commander has missing provenance with no recorded decision',
    );
  });

  it('normalizes array-shaped registry metadata and falls back to installed licenses', async () => {
    for (const [name, view] of views) {
      if (Array.isArray(view)) throw new Error('Expected an unwrapped fixture view.');
      const { license, ...metadata } = view;
      views.set(name, [snapshot.licenses.includes(license ?? '') ? metadata : view]);
    }
    await command();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('production audit clean'));
  });

  it('rejects a license category outside the allowlist independently of direct dependencies', async () => {
    licenseOutput = JSON.stringify({ ...JSON.parse(licenseOutput), 'UNRECOGNIZED-TRANSITIVE': [] });
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith(
      '  license UNRECOGNIZED-TRANSITIVE is not allowlisted',
    );
  });

  it('accepts the actual workspace inventory without writing policy artifacts', async () => {
    await command();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('production audit clean'));
    expect(boundary.command).toHaveBeenCalledWith(
      process.execPath,
      ['fixture-package-manager.cjs', 'audit', '--audit-level', 'high'],
      expect.any(Object),
    );
    expect(writes.size).toBe(0);
  });

  it('rejects production audit findings even when the audit command exits unsuccessfully', async () => {
    auditFailure = { stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 2 } } }) };
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith('  production audit reports 2 vulnerabilities');
    expect(writes.size).toBe(0);
  });

  it('fails closed for an audit command with no usable JSON', async () => {
    auditFailure = { stdout: '' };
    await expect(command()).rejects.toBe(auditFailure);
    expect(writes.size).toBe(0);
  });

  it('fails closed for malformed audit JSON', async () => {
    auditFailure = { stdout: 'not JSON' };
    await expect(command()).rejects.toBeInstanceOf(SyntaxError);
    expect(writes.size).toBe(0);
  });

  it('records absent registry metadata without inventing a release version or date', async () => {
    views.set('commander', []);
    await command('--write');
    const text = writes.get(REPORT);
    if (text === undefined) throw new Error('Expected report output.');
    const report = JSON.parse(text) as {
      dependencies: {
        name: string;
        latestVersion: unknown;
        latestReleaseAt: unknown;
        pinnedPublishedAt: unknown;
        daysSinceLastRelease: unknown;
      }[];
    };
    expect(report.dependencies.find((item) => item.name === 'commander')).toMatchObject({
      latestVersion: null,
      latestReleaseAt: null,
      pinnedPublishedAt: null,
      daysSinceLastRelease: null,
    });
  });

  it('rejects unknown dependency licenses and stale policy artifacts', async () => {
    const dependency = snapshot.dependencies[0];
    if (dependency === undefined) throw new Error('Expected committed dependencies.');
    for (const key of [
      dependency.name,
      ...dependency.specifiers.map((value) => `${dependency.name}@${value}`),
    ]) {
      const view = views.get(key);
      if (view === undefined || Array.isArray(view)) throw new Error('Expected fixture view.');
      views.set(key, { ...view, license: 'UNRECOGNIZED-LICENSE' });
    }
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('license UNRECOGNIZED-LICENSE is not allowlisted'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('dependency-health.json is stale'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('sbom.cyclonedx.json is stale'),
    );
  });

  it('rejects a contributor audit failure independently of the production audit', async () => {
    contributorFailure = new Error('fixture contributor audit unavailable');
    await expect(command()).rejects.toThrow('exit:1');
    expect(console.error).toHaveBeenCalledWith('fixture contributor audit unavailable');
    expect(console.error).toHaveBeenCalledWith(
      '  contributor audit failed; run pnpm audit --audit-level high',
    );
  });

  it('does not accept empty license output without the Windows fallback', async () => {
    licenseOutput = '';
    if (process.platform === 'win32') {
      await command();
      expect(writes.size).toBe(0);
      return;
    }
    await expect(command()).rejects.toThrow('produced no JSON output');
  });

  it('writes a report and SBOM to the output port while preserving committed files', async () => {
    vi.stubEnv('LOREPACK_VERSION', '0.1.0-fixture');
    await command('--write');
    expect(writes.size).toBe(2);
    const reportText = writes.get(REPORT);
    const sbomText = writes.get(SBOM);
    if (reportText === undefined || sbomText === undefined)
      throw new Error('Expected both report artifacts.');
    const report = JSON.parse(reportText);
    const sbom = JSON.parse(sbomText);
    expect(report.dependencies).toHaveLength(snapshot.dependencies.length);
    expect(report.audit.vulnerabilities).toEqual(snapshot.audit.vulnerabilities);
    expect(report.provenance.missing).toEqual(expect.arrayContaining(['commander', 'yaml']));
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: {
        component: { name: 'lorepack', version: '0.1.0-fixture' },
      },
    });
    expect(sbom.components).toHaveLength(snapshot.dependencies.length);
    expect(boundary.command.mock.calls.some(([, args]) => args.includes('high'))).toBe(false);
  });
});
