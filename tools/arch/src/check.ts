import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  ALLOWED_WORKSPACE_EDGES,
  FORBIDDEN_EXTERNAL,
  NO_BARE_ERROR_PACKAGES,
  PACKAGES,
  type PackageName,
  TEST_ONLY_PACKAGES,
} from './rules.js';
import { collectImports, listSourceFiles, workspaceDependency } from './scan.js';

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
      if (TEST_ONLY_PACKAGES.includes(workspace)) continue;
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

/**
 * `throw new Error(...)` gives a user a stack trace and no next step. The engine guard is
 * the one exception: it runs before the error module can safely be imported.
 */
export function checkBareErrors(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  const pattern = /\bthrow\s+new\s+(Error|TypeError|RangeError)\s*\(/g;
  for (const name of NO_BARE_ERROR_PACKAGES) {
    const dir = join(repoRoot, 'packages', name, 'src');
    if (!existsSync(dir)) continue;
    for (const file of listSourceFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(source);
      while (match !== null) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push({
          file: file
            .slice(repoRoot.length + 1)
            .split(sep)
            .join('/'),
          line,
          specifier: match[0],
          rule: `@lorepack/${name} must throw LoreError with a stable code, not a bare ${match[1]}. See AGENTS.md and architecture section 6.9.`,
        });
        match = pattern.exec(source);
      }
    }
  }
  return violations;
}
