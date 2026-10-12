import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { captureCoverage } from './coverage_report.mjs';

const require = createRequire(import.meta.url);
const providerRequire = createRequire(require.resolve('@vitest/coverage-v8'));
const { convert } = await import(providerRequire.resolve('ast-v8-to-istanbul'));
const { parseAstAsync } = await import(require.resolve('vitest/node'));
const { createCoverageMap } = providerRequire('istanbul-lib-coverage');

export async function convertNativeCoverage(snapshot, records, direct = {}) {
  const root = realpathSync(snapshot.root);
  const owned = new Map(snapshot.included.map((entry) => [entry.path, entry]));
  const sources = new Map();
  const merged = createCoverageMap({});
  const rejected = [];
  let acceptedExecutions = 0;
  for (const { origin, result } of records) {
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
        const ast = await parseAstAsync(code);
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
      const maps = await convert({ ...source, coverage, wrapperLength: 0 });
      for (const [convertedPath, map] of Object.entries(maps)) {
        if (realpathSync(convertedPath) !== realpathSync(absolute))
          throw new Error(`Native conversion changed source path: ${path}`);
        const previous = merged.files().includes(convertedPath)
          ? merged.fileCoverageFor(convertedPath).toJSON()
          : direct[convertedPath];
        const mismatch = previous
          ? ['statementMap', 'fnMap', 'branchMap'].filter(
              (field) => !isDeepStrictEqual(previous[field], map[field]),
            )
          : [];
        if (mismatch.length) {
          rejected.push({ origin, path, reason: 'Incompatible coverage maps', mismatch });
          continue;
        }
        merged.merge({ [convertedPath]: structuredClone(map) });
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    const records = readdirSync(values.raw)
      .filter((file) => /^coverage-.*\.json$/.test(file))
      .sort()
      .map((origin) => ({ origin, result: readJson(join(values.raw, origin)).result }));
    if (!records.length) throw new Error('No Node V8 coverage records found.');
    const measured = await convertNativeCoverage(
      snapshot,
      records,
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
