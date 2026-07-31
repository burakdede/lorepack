import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ImportRecord {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
}

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Collects import specifiers by regex rather than by building a TypeScript program.
 * The rule set only needs the specifier string, and a regex keeps this check fast enough
 * to run on every commit without a heavyweight architecture framework.
 */
const PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*import\s+(?:type\s+)?[^'"\n]*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+(?:type\s+)?[^'"\n]*from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (SOURCE.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

export function collectImports(dir: string, repoRoot: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  for (const file of listSourceFiles(dir)) {
    const raw = readFileSync(file, 'utf8');
    const source = stripComments(raw);
    const lines = raw.split('\n');
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(source);
      while (match !== null) {
        const specifier = match[1];
        if (specifier !== undefined) {
          // The patterns may capture a leading newline, so count to the specifier itself
          // rather than to the match start; otherwise every line number is one too low.
          const specifierOffset = source.indexOf(specifier, match.index);
          const upto = source.slice(0, specifierOffset < 0 ? match.index : specifierOffset);
          const line = upto.split('\n').length;
          records.push({
            file: relative(repoRoot, file).split(sep).join('/'),
            specifier,
            line: Math.min(line, lines.length),
          });
        }
        match = pattern.exec(source);
      }
    }
  }
  return records;
}

export function workspaceDependency(specifier: string): string | null {
  const match = /^@lorepack\/([^/]+)/.exec(specifier);
  return match?.[1] ?? null;
}
