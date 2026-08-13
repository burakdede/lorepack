#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const REPORT = join(ROOT, 'reports', 'dependency-health.json');
const SBOM = join(ROOT, 'reports', 'sbom.cyclonedx.json');
const DOC = join(ROOT, 'docs', 'architecture', 'dependencies.md');
const WORKSPACE_DIRS = ['packages', 'apps', 'tools'];
const ALLOWED_LICENSES = new Set([
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT OR Apache-2.0',
  'MPL-2.0',
  'OFL-1.1',
  '(MIT AND Zlib)',
  '(MIT OR GPL-3.0-or-later)',
]);
const STALE_AFTER_DAYS = 548;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function workspaceManifests() {
  const manifests = [join(ROOT, 'package.json')];
  for (const dir of WORKSPACE_DIRS) {
    const parent = join(ROOT, dir);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const manifest = join(parent, entry, 'package.json');
      if (existsSync(manifest)) manifests.push(manifest);
    }
  }
  return manifests.sort((a, b) => a.localeCompare(b));
}

function packageLabel(manifestPath) {
  return relative(ROOT, manifestPath).replaceAll('\\', '/');
}

function directDependencies() {
  const out = new Map();
  for (const manifestPath of workspaceManifests()) {
    const manifest = readJson(manifestPath);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (String(specifier).startsWith('workspace:')) continue;
        const record = out.get(name) ?? {
          name,
          references: [],
          specifiers: new Set(),
          dependencyTypes: new Set(),
        };
        record.references.push(`${packageLabel(manifestPath)}:${section}`);
        record.specifiers.add(specifier);
        record.dependencyTypes.add(section);
        out.set(name, record);
      }
    }
  }
  return [...out.values()]
    .map((record) => ({
      ...record,
      specifiers: [...record.specifiers].sort(),
      dependencyTypes: [...record.dependencyTypes].sort(),
      references: record.references.sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath?.endsWith('.cjs') === true || npmExecPath?.endsWith('.js') === true) {
    return run(process.execPath, [npmExecPath, ...args]);
  }
  if (npmExecPath !== undefined) {
    return run(npmExecPath, args, { shell: process.platform === 'win32' });
  }
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    shell: process.platform === 'win32',
  });
}

function runNpm(args) {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    shell: process.platform === 'win32',
  });
}

function npmView(name) {
  return JSON.parse(runNpm(['view', name, 'version', 'time', 'license', 'dist', '--json']));
}

function auditJson() {
  try {
    const stdout = runPnpm(['audit', '--prod', '--audit-level', 'moderate', '--json']);
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = error.stdout?.toString() ?? '';
    if (stdout.trim() !== '') return JSON.parse(stdout);
    throw error;
  }
}

function licenseInventory() {
  const stdout = runPnpm(['licenses', 'list', '--prod', '--json']);
  if (stdout.trim() !== '') return JSON.parse(stdout);
  if (process.platform !== 'win32' || !existsSync(REPORT)) {
    throw new Error('pnpm licenses list --prod --json produced no JSON output');
  }
  return Object.fromEntries(readJson(REPORT).licenses.map((license) => [license, []]));
}

function packageLicenseMap(licenses) {
  const map = new Map();
  for (const [license, entries] of Object.entries(licenses)) {
    for (const entry of entries) {
      const current = map.get(entry.name);
      map.set(
        entry.name,
        current === undefined ? license : current === license ? license : 'mixed',
      );
    }
  }
  return map;
}

function daysBetween(a, b) {
  return Math.floor((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function newestRegistryDate(view) {
  return Object.entries(view.time ?? {})
    .filter(([version]) => !['created', 'modified'].includes(version))
    .map(([, date]) => date)
    .sort()
    .at(-1);
}

function pinnedPublishDate(view, specifiers) {
  const exact = specifiers.find((specifier) => /^\d+\.\d+\.\d+/.test(specifier));
  return exact === undefined ? null : (view.time?.[exact] ?? null);
}

function pinnedSpecifier(specifiers) {
  return specifiers.find((specifier) => /^\d+\.\d+\.\d+$/.test(specifier)) ?? null;
}

function provenanceStatus(view, dependency) {
  if (!dependency.dependencyTypes.includes('dependencies')) {
    return { status: 'not-required', reason: 'not in the production direct dependency set' };
  }
  const pinned = pinnedSpecifier(dependency.specifiers);
  if (pinned === null) {
    return { status: 'not-checked', reason: 'specifier is not an exact production version' };
  }
  const predicateType = view.dist?.attestations?.provenance?.predicateType;
  if (predicateType === undefined) {
    return { status: 'missing', reason: 'npm registry metadata has no provenance attestation' };
  }
  return {
    status: 'present',
    predicateType,
    url: view.dist?.attestations?.url ?? null,
  };
}

function healthReport() {
  const licenses = licenseInventory();
  const licenseByPackage = packageLicenseMap(licenses);
  const audit = auditJson();
  const vulnerabilities = audit.metadata?.vulnerabilities ?? {};
  const dependencies = directDependencies().map((dependency) => {
    const view = npmView(dependency.name);
    const latestReleaseAt = newestRegistryDate(view);
    const pinnedPublishedAt = pinnedPublishDate(view, dependency.specifiers);
    const daysSinceLastRelease =
      latestReleaseAt === undefined
        ? null
        : daysBetween('2026-08-14T00:00:00.000Z', latestReleaseAt);
    return {
      name: dependency.name,
      specifiers: dependency.specifiers,
      dependencyTypes: dependency.dependencyTypes,
      references: dependency.references,
      latestVersion: view.version ?? null,
      pinnedPublishedAt,
      latestReleaseAt: latestReleaseAt ?? null,
      daysSinceLastRelease,
      license: licenseByPackage.get(dependency.name) ?? view.license ?? 'unknown',
      provenance: provenanceStatus(view, dependency),
      health:
        daysSinceLastRelease !== null && daysSinceLastRelease > STALE_AFTER_DAYS
          ? {
              status: 'stale-warning',
              owner: 'maintainer',
              decision:
                'See docs/architecture/dependencies.md for the recorded dependency decision.',
            }
          : { status: 'current' },
    };
  });
  return {
    schemaVersion: 1,
    policyDate: '2026-08-14',
    staleAfterDays: STALE_AFTER_DAYS,
    audit: {
      command: 'pnpm audit --prod --audit-level moderate --json',
      vulnerabilities,
    },
    licenses: Object.keys(licenses).sort(),
    provenance: {
      checked: dependencies.filter((dependency) => dependency.provenance.status === 'present')
        .length,
      missing: dependencies
        .filter((dependency) => dependency.provenance.status === 'missing')
        .map((dependency) => dependency.name),
      notChecked: dependencies
        .filter((dependency) => dependency.provenance.status === 'not-checked')
        .map((dependency) => dependency.name),
    },
    dependencies,
  };
}

function cyclonedxFromReport(report) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000099',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'lorepack', version: '0.0.0' },
    },
    components: report.dependencies.map((dependency) => ({
      type: 'library',
      name: dependency.name,
      version: dependency.specifiers.join(' || '),
      licenses: [{ expression: dependency.license }],
      properties: [
        { name: 'lorepack:latestVersion', value: String(dependency.latestVersion) },
        { name: 'lorepack:latestReleaseAt', value: String(dependency.latestReleaseAt) },
        { name: 'lorepack:provenanceStatus', value: dependency.provenance.status },
      ],
    })),
  };
}

function checkPublishConfig(problems) {
  for (const manifestPath of workspaceManifests()) {
    const manifest = readJson(manifestPath);
    if (manifest.private === true || manifestPath === join(ROOT, 'package.json')) continue;
    if (manifest.publishConfig?.provenance !== true) {
      problems.push(`${packageLabel(manifestPath)}: publishConfig.provenance must be true`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      problems.push(`${packageLabel(manifestPath)}: publishConfig.access must be public`);
    }
  }
}

function checkLicenses(report, problems) {
  for (const license of report.licenses) {
    if (!ALLOWED_LICENSES.has(license)) problems.push(`license ${license} is not allowlisted`);
  }
  for (const dependency of report.dependencies) {
    if (!ALLOWED_LICENSES.has(dependency.license)) {
      problems.push(`${dependency.name}: license ${dependency.license} is not allowlisted`);
    }
  }
}

function checkAudit(report, problems) {
  const count = Object.values(report.audit.vulnerabilities).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  if (count > 0) problems.push(`production audit reports ${count} vulnerabilities`);
}

function checkDocs(report, problems) {
  const text = readFileSync(DOC, 'utf8');
  for (const dependency of report.dependencies) {
    if (!text.includes(`\`${dependency.name}\``)) {
      problems.push(`docs/architecture/dependencies.md has no rationale for ${dependency.name}`);
    }
    if (dependency.health.status === 'stale-warning' && !text.includes(dependency.name)) {
      problems.push(`stale dependency ${dependency.name} has no recorded decision`);
    }
    if (dependency.provenance.status === 'missing' && !text.includes(dependency.name)) {
      problems.push(
        `dependency ${dependency.name} has missing provenance with no recorded decision`,
      );
    }
  }
}

function checkReportFresh(report, problems) {
  if (!existsSync(REPORT)) {
    problems.push('reports/dependency-health.json is missing; run pnpm supply-chain:report');
    return;
  }
  const current = readFileSync(REPORT, 'utf8');
  const expected = `${JSON.stringify(report, null, 2)}\n`;
  if (current !== expected) {
    problems.push('reports/dependency-health.json is stale; run pnpm supply-chain:report');
  }
}

function checkSbomFresh(report, problems) {
  if (!existsSync(SBOM)) {
    problems.push('reports/sbom.cyclonedx.json is missing; run pnpm supply-chain:report');
    return;
  }
  const current = readFileSync(SBOM, 'utf8');
  const expected = `${JSON.stringify(cyclonedxFromReport(report), null, 2)}\n`;
  if (current !== expected) {
    problems.push('reports/sbom.cyclonedx.json is stale; run pnpm supply-chain:report');
  }
}

function main() {
  const write = process.argv.includes('--write');
  const report = healthReport();
  if (write) {
    writeJson(REPORT, report);
    writeJson(SBOM, cyclonedxFromReport(report));
    console.log(
      `supply-chain: wrote ${relative(ROOT, REPORT)} and ${relative(ROOT, SBOM)} for ${report.dependencies.length} direct dependencies`,
    );
    return;
  }

  const problems = [];
  checkPublishConfig(problems);
  checkLicenses(report, problems);
  checkAudit(report, problems);
  checkDocs(report, problems);
  checkReportFresh(report, problems);
  checkSbomFresh(report, problems);

  if (problems.length > 0) {
    console.error('check:supply-chain failed.\n');
    for (const problem of problems.sort((a, b) => a.localeCompare(b))) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `check:supply-chain: ${report.dependencies.length} direct dependencies, ${report.licenses.length} licenses, ${report.provenance.missing.length} missing provenance attestations, audit clean`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
