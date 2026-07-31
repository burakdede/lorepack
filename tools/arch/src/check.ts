import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_WORKSPACE_EDGES,
  FORBIDDEN_EXTERNAL,
  PACKAGES,
  type PackageName,
} from './rules.js';
import { collectImports, workspaceDependency } from './scan.js';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly rule: string;
}

function matches(specifier: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? specifier === pattern : pattern.test(specifier);
}

export function checkPackage(repoRoot: string, name: PackageName): Violation[] {
  const dir = join(repoRoot, 'packages', name, 'src');
  if (!existsSync(dir)) return [];

  const violations: Violation[] = [];
  const allowed = ALLOWED_WORKSPACE_EDGES[name];
  const forbidden = FORBIDDEN_EXTERNAL[name] ?? [];

  for (const record of collectImports(dir, repoRoot)) {
    const workspace = workspaceDependency(record.specifier);
    if (workspace !== null) {
      if (workspace === name) continue;
      if (!allowed.includes(workspace as PackageName)) {
        violations.push({
          ...record,
          rule: `@lorepack/${name} may not import @lorepack/${workspace}. Allowed: ${
            allowed.length > 0 ? allowed.map((a) => `@lorepack/${a}`).join(', ') : 'nothing'
          }.`,
        });
      }
      continue;
    }
    for (const pattern of forbidden) {
      if (matches(record.specifier, pattern)) {
        violations.push({
          ...record,
          rule: `@lorepack/${name} may not import "${record.specifier}". Architecture section 9.1 keeps this package free of parser, database, protocol, UI, and Cloudflare code.`,
        });
        break;
      }
    }
  }
  return violations;
}

export function checkAll(repoRoot: string): Violation[] {
  return PACKAGES.flatMap((name) => checkPackage(repoRoot, name));
}

/** Declared workspace dependencies must not exceed the allowed edges either. */
export function checkManifests(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const name of PACKAGES) {
    const manifestPath = join(repoRoot, 'packages', name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const dep of declared) {
      const workspace = workspaceDependency(dep);
      if (workspace === null) continue;
      if (!ALLOWED_WORKSPACE_EDGES[name].includes(workspace as PackageName)) {
        violations.push({
          file: `packages/${name}/package.json`,
          line: 1,
          specifier: dep,
          rule: `@lorepack/${name} declares a dependency on ${dep}, which the allowed edges forbid.`,
        });
      }
    }
  }
  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line}\n    imports "${v.specifier}"\n    ${v.rule}`)
    .join('\n\n');
}
