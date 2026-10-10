import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'packages', 'cli');
const dist = join(cli, 'dist');
const entry = join(dist, 'entry.js');
const publicEntry = join(dist, 'public-entry.js');
const index = join(dist, 'index.js');
const publicIndex = join(dist, 'public-index.js');
// The table query runs in a forked process, so its entry is a file on disk that the bundle
// cannot inline. Emitted beside `public-entry.js`, where `childEntry()` in
// `packages/backend-local/src/sql/execute.ts` looks first (#639).
const queryChild = join(root, 'packages', 'backend-local', 'dist', 'sql', 'query-child.js');
const publicQueryChild = join(dist, 'query-child.js');
// The parse process (#594). `ParserHost` forks `./parse-child.js` relative to its own module,
// and once bundled its module is `public-entry.js`, so the child has to sit beside it.
const parseChild = join(root, 'packages', 'parsers', 'dist', 'parse-child.js');
const publicParseChild = join(dist, 'parse-child.js');
const sourceMigrations = join(root, 'packages', 'backend-local', 'migrations');
const targetMigrations = join(cli, 'dist', 'migrations');
const externalDependencies = [
  '@hono/*',
  '@modelcontextprotocol/*',
  'chokidar',
  'commander',
  'csv-parse',
  'hono',
  'jose',
  'jsonc-parser',
  'mammoth',
  'mdast-util-from-markdown',
  'pdfjs-dist',
  'rehype-parse',
  'remark-frontmatter',
  'remark-gfm',
  'remark-parse',
  'sax',
  'smol-toml',
  'unified',
  'yaml',
  'yauzl',
  'yazl',
];

for (const compiled of [entry, queryChild, parseChild]) {
  if (!existsSync(compiled)) {
    throw new Error(`${compiled} is missing. Run tsc -b before bundling.`);
  }
}

for (const [entryPoint, outfile] of [
  [entry, publicEntry],
  [index, publicIndex],
  [queryChild, publicQueryChild],
  [parseChild, publicParseChild],
]) {
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    external: externalDependencies,
    format: 'esm',
    outfile,
    platform: 'node',
    sourcemap: true,
    target: 'node24',
  });
}

mkdirSync(dirname(targetMigrations), { recursive: true });
rmSync(targetMigrations, { recursive: true, force: true });
cpSync(sourceMigrations, targetMigrations, { recursive: true });

console.log('bundled @lorepack/cli with its internal workspace packages');
