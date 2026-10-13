import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { captureCoverage } from './coverage_report.mjs';

const require = createRequire(import.meta.url);
const providerRequire = createRequire(require.resolve('@vitest/coverage-v8'));
const { convert } = await import(pathToFileURL(providerRequire.resolve('ast-v8-to-istanbul')).href);
const { parseAstAsync } = await import(pathToFileURL(require.resolve('vitest/node')).href);
const { createCoverageMap } = providerRequire('istanbul-lib-coverage');

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, ordered(entry)]),
  );
}

function descriptorKey(entry, field) {
  const descriptor = structuredClone(entry);
  if (field !== 'statementMap' && Object.hasOwn(descriptor, 'line')) {
    if (!Number.isSafeInteger(descriptor.line) || descriptor.line !== descriptor.loc?.start?.line)
      return null;
    delete descriptor.line;
  }
  return JSON.stringify(ordered(descriptor));
}

function alignMaps(map, previous) {
  const aligned = structuredClone(map);
  const mismatch = [];
  for (const [field, counts] of [
    ['statementMap', 's'],
    ['fnMap', 'f'],
    ['branchMap', 'b'],
  ]) {
    if (isDeepStrictEqual(previous[field], map[field])) continue;
    const source = Object.entries(map[field]);
    const target = Object.entries(previous[field]);
    const sourceKeys = source.map(([id, entry]) => [descriptorKey(entry, field), id]);
    const targetKeys = target.map(([id, entry]) => [descriptorKey(entry, field), id]);
    const index = new Map(sourceKeys);
    if (
      source.length !== target.length ||
      index.size !== source.length ||
      new Set(targetKeys.map(([key]) => key)).size !== target.length ||
      sourceKeys.some(([key]) => key === null) ||
      targetKeys.some(([key]) => key === null || !index.has(key))
    ) {
      mismatch.push(field);
      continue;
    }
    aligned[field] = structuredClone(previous[field]);
    aligned[counts] = Object.fromEntries(
      targetKeys.map(([key, id]) => [id, structuredClone(map[counts][index.get(key)])]),
    );
  }
  return { aligned, mismatch };
}

export async function convertNativeCoverage(snapshot, records, direct = {}) {
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [entry.path, entry]));
  const sources = new Map();
  const merged = createCoverageMap({});
  const rejected = [];
  let acceptedExecutions = 0;
  for await (const { origin, result } of records) {
    for (const coverage of result) {
      if (!coverage.url.startsWith('file:')) continue;
      const absolute = fileURLToPath(coverage.url);
      const path = relative(root, absolute).split('\\').join('/');
      if (!owned.has(path)) continue;
      if (!path.endsWith('.mjs') && !/(?:vite|vitest)\.config\.ts$/.test(path)) {
        rejected.push({
          origin,
          path,
          reason: 'Native source conversion is not validated for this layout.',
        });
        continue;
      }
      let source = sources.get(path);
      if (!source) {
        const code = readFileSync(absolute, 'utf8');
        if (createHash('sha256').update(code).digest('hex') !== owned.get(path).sha256)
          throw new Error(`Stale native coverage source: ${path}`);
        const parsedCode = path.endsWith('.ts')
          ? stripTypeScriptTypes(code, { mode: 'strip' })
          : code;
        const ast = await parseAstAsync(parsedCode);
        // The pinned converter lacks a visitor for evaluated default-export calls.
        ast.body = ast.body.map((node) =>
          node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'CallExpression'
            ? {
                type: 'ExpressionStatement',
                expression: node.declaration,
                start: node.declaration.start,
                end: node.declaration.end,
                loc: node.declaration.loc,
              }
            : node,
        );
        source = { code, ast };
        sources.set(path, source);
      }
      const scriptRange = coverage.functions[0]?.ranges[0];
      const expectedLength = path.endsWith('.ts')
        ? stripTypeScriptTypes(source.code, { mode: 'strip', sourceUrl: coverage.url }).length
        : source.code.length;
      if (scriptRange?.startOffset !== 0 || scriptRange.endOffset !== expectedLength) {
        rejected.push({
          origin,
          path,
          reason: 'Native execution offsets do not match the owned source.',
          expectedLength,
          observedLength: scriptRange?.endOffset ?? null,
        });
        continue;
      }
      const maps = await convert({ ...source, coverage, wrapperLength: 0 });
      for (const [convertedPath, map] of Object.entries(maps)) {
        if (realpathSync(convertedPath) !== realpathSync(absolute))
          throw new Error(`Native conversion changed source path: ${path}`);
        if (Object.values(map.branchMap).some((branch) => branch.type === 'default-arg')) {
          rejected.push({
            origin,
            path,
            reason: 'V8 default-parameter execution is not recoverable.',
          });
          continue;
        }
        const previous = merged.files().includes(convertedPath)
          ? merged.fileCoverageFor(convertedPath).toJSON()
          : direct[convertedPath];
        const { aligned, mismatch } = previous
          ? alignMaps(map, previous)
          : { aligned: map, mismatch: [] };
        if (mismatch.length) {
          rejected.push({ origin, path, reason: 'Incompatible coverage maps', mismatch });
          continue;
        }
        merged.merge({ [convertedPath]: structuredClone(aligned) });
        acceptedExecutions++;
      }
    }
  }
  return {
    maps: Object.fromEntries(
      merged.files().map((path) => [path, merged.fileCoverageFor(path).toJSON()]),
    ),
    acceptedExecutions,
    rejected,
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        inventory: { type: 'string' },
        raw: { type: 'string' },
        direct: { type: 'string' },
        origin: { type: 'string' },
        out: { type: 'string' },
      },
    });
    if (!values.inventory || !values.raw || !values.origin || !values.out)
      throw new Error(
        'Use --inventory <snapshot> --raw <Node V8 directory> --origin <label> --out <bundle>, with optional --direct <Istanbul map>.',
      );
    const readJson = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
    const snapshot = readJson(values.inventory);
    const files = readdirSync(values.raw)
      .filter((file) => /^coverage-.*\.json$/.test(file))
      .sort();
    if (!files.length) throw new Error('No Node V8 coverage records found.');
    async function* records() {
      for (const origin of files)
        yield { origin, result: readJson(join(values.raw, origin)).result };
    }
    const measured = await convertNativeCoverage(
      snapshot,
      records(),
      values.direct ? readJson(values.direct) : {},
    );
    const bundle = {
      ...captureCoverage(snapshot, measured.maps, values.origin),
      nativeEvidence: {
        acceptedExecutions: measured.acceptedExecutions,
        rejected: measured.rejected,
      },
    };
    const output = resolve(values.out);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(bundle, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
