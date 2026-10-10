import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import {
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';

/**
 * One module reference found in a source file.
 *
 * `computed` marks a reference whose target cannot be known by reading the source: a
 * non-literal `import()` or `require()`, or a module loader reached by name, such as
 * `process.getBuiltinModule`. `specifier` is then the source text, for the report.
 */
export interface ImportRecord {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
  readonly computed: boolean;
}

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * Names that load a module chosen at run time, so a rule over specifiers cannot see what
 * they load. `getBuiltinModule('node:sqlite')` reaches the database with no import at all,
 * and `createRequire` returns a `require` that does the same (#617).
 */
export const MODULE_LOADERS: ReadonlySet<string> = new Set(['getBuiltinModule', 'createRequire']);

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

const literalText = (node: Node | undefined): string | null =>
  node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;

/**
 * Every module reference in one parsed file, from the syntax tree.
 *
 * The first version matched regexes over the text, which a multi-line import, a computed
 * `import(name)` and `process.getBuiltinModule` all walked past (#617). The parser sees an
 * import however it is laid out, and anything that loads a module by a name the source does
 * not spell out is reported as computed rather than ignored.
 */
export function referencesIn(source: SourceFile, file: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const at = (node: Node, specifier: string, computed: boolean): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    records.push({ file, specifier, line, computed });
  };
  const moduleCall = (node: Node, argument: Node | undefined): void => {
    const text = literalText(argument);
    if (text !== null && argument !== undefined) at(argument, text, false);
    else at(node, node.getText(source), true);
  };

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const text = literalText(node.moduleSpecifier);
      if (text !== null && node.moduleSpecifier !== undefined)
        at(node.moduleSpecifier, text, false);
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      moduleCall(node, node.moduleReference.expression);
    } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      const text = literalText(node.argument.literal);
      if (text !== null) at(node.argument, text, false);
    } else if (isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === SyntaxKind.ImportKeyword) moduleCall(node, node.arguments[0]);
      else if (
        (isIdentifier(callee) && callee.text === 'require') ||
        (isPropertyAccessExpression(callee) && callee.name.text === 'require')
      ) {
        moduleCall(node, node.arguments[0]);
      }
    } else if (isIdentifier(node) && MODULE_LOADERS.has(node.text)) {
      at(node, node.text, true);
    } else if (isElementAccessExpression(node)) {
      const key = literalText(node.argumentExpression);
      if (key !== null && MODULE_LOADERS.has(key)) at(node, node.getText(source), true);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return records;
}

/**
 * Parses every file with the TypeScript compiler and returns its module references.
 *
 * TypeScript 7 is the compiler `pnpm typecheck` already runs, and its API is the parser
 * the architecture rules need without adding one. The API is published as `unstable`, so
 * the version is pinned exactly in the root manifest; a break shows up here, at `test:arch`.
 */
export function collectReferences(files: readonly string[], repoRoot: string): ImportRecord[] {
  if (files.length === 0) return [];
  const api = new API({ cwd: repoRoot });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [...files] });
    return files.flatMap((file) => {
      const source = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (source === undefined) {
        throw new Error(`the TypeScript compiler did not load ${file}, so it cannot be checked`);
      }
      return referencesIn(source, relative(repoRoot, file).split(sep).join('/'));
    });
  } finally {
    api.close();
  }
}

export function collectImports(dir: string, repoRoot: string): ImportRecord[] {
  return collectReferences(listSourceFiles(dir), repoRoot);
}

export function workspaceDependency(specifier: string): string | null {
  const match = /^@lorepack\/([^/]+)/.exec(specifier);
  return match?.[1] ?? null;
}
